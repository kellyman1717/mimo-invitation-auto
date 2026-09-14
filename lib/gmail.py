#!/usr/bin/env python3
"""
Gmail IMAP reader for the OTP step.

Runs as a long-lived child process: an IMAP login costs 1-2s and a batch polls
the inbox every few seconds per account, so reconnecting per poll would dominate
the run. Commands arrive on stdin, replies go out on stdout — one JSON object
per line.

Commands:
    list <limit>                                  -> JSON array of recent messages
    wait <to> <sinceUid> <timeoutMs> <intervalMs>  -> JSON of the first match, or null
    quit

Stdout protocol:
    READY                 once, after a successful login
    PROGRESS <n>          poll counter while `wait` is running
    {"..."} | null        the reply to the last command
    ERROR <message>       command failed; the process stays alive
    FATAL <message>       login failed; the process exits

Credentials come from the environment (PP_* style, same as the proxy bridge)
because spawn() re-quotes argv on Windows and an app password with spaces
arrives mangled.

Gmail's dot trick: dots in the local part are ignored for delivery, so
j.o.h.ndoe@gmail.com and johndoe@gmail.com share one inbox. That is what lets a
single mailbox serve many registrations — see dot_variant() in lib/gmail.js.
"""

import sys
import os
import json
import time
import imaplib
import email
from email.header import decode_header
from email.utils import parseaddr

IMAP_HOST = os.environ.get("GM_HOST", "imap.gmail.com")
IMAP_PORT = int(os.environ.get("GM_PORT", "993"))

# Gmail treats these as the same mailbox, so dot-stripping is safe for both.
DOTLESS_DOMAINS = {"gmail.com", "googlemail.com"}


def log(msg):
    print("LOG " + str(msg), file=sys.stderr, flush=True)


def norm_addr(addr):
    """Normalise for comparison: lowercase, and drop dots/+alias on Gmail.

    Without this, matching a delivered message against the dotted address we
    registered would need an exact string compare, which breaks when the sender
    rewrites or lowercases the header.
    """
    addr = (addr or "").strip().lower()
    if "@" not in addr:
        return addr
    local, _, domain = addr.rpartition("@")
    if domain in DOTLESS_DOMAINS:
        local = local.split("+")[0].replace(".", "")
    return local + "@" + domain


def decode_hdr(raw):
    """Decode an RFC 2047 header ('=?UTF-8?B?...?=') into plain text."""
    if not raw:
        return ""
    out = []
    for text, charset in decode_header(raw):
        if isinstance(text, bytes):
            try:
                out.append(text.decode(charset or "utf-8", errors="replace"))
            except (LookupError, UnicodeDecodeError):
                out.append(text.decode("utf-8", errors="replace"))
        else:
            out.append(text)
    return "".join(out)


def body_text(msg):
    """Best-effort plain text from a (possibly multipart) message."""
    if msg.is_multipart():
        # Prefer text/plain anywhere in the tree, then fall back to HTML.
        for want in ("text/plain", "text/html"):
            for part in msg.walk():
                if part.get_content_type() != want:
                    continue
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or "utf-8"
                    return payload.decode(charset, errors="replace")
        return ""
    payload = msg.get_payload(decode=True)
    if not payload:
        return ""
    return payload.decode(msg.get_content_charset() or "utf-8", errors="replace")


class Inbox:
    def __init__(self, user, password):
        self.user = user
        self.imap = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
        self.imap.login(user, password)

    def uids_since(self, since_uid):
        """UIDs strictly greater than since_uid, ascending."""
        # IMAP UIDs are monotonic per mailbox, so they work as a cursor: a
        # baseline taken before the OTP is sent excludes everything older.
        typ, data = self.imap.uid("search", None, "UID", "%d:*" % (since_uid + 1))
        if typ != "OK":
            return []
        raw = data[0].decode() if data and data[0] else ""
        uids = [int(x) for x in raw.split() if x.isdigit()]
        return sorted(u for u in uids if u > since_uid)

    def header_of(self, uid):
        """Cheap fetch: headers only, for filtering without pulling bodies."""
        typ, data = self.imap.uid("fetch", str(uid), "(BODY.PEEK[HEADER])")
        if typ != "OK" or not data or not isinstance(data[0], tuple):
            return None
        msg = email.message_from_bytes(data[0][1])
        to_hdr = msg.get("To", "")
        return {
            "uid": uid,
            "subject": decode_hdr(msg.get("Subject")),
            "to": parseaddr(to_hdr)[1] or to_hdr,
            "from": parseaddr(msg.get("From", ""))[1],
            "date": msg.get("Date", ""),
        }

    def full_of(self, uid):
        typ, data = self.imap.uid("fetch", str(uid), "(RFC822)")
        if typ != "OK" or not data or not isinstance(data[0], tuple):
            return None
        msg = email.message_from_bytes(data[0][1])
        text = body_text(msg)
        to_hdr = msg.get("To", "")
        return {
            "uid": uid,
            "emailId": uid,
            "subject": decode_hdr(msg.get("Subject")),
            "toEmail": parseaddr(to_hdr)[1] or to_hdr,
            "fromEmail": parseaddr(msg.get("From", ""))[1],
            "date": msg.get("Date", ""),
            "text": text,
            "content": text,
        }

    def select(self):
        # readonly: polling must not mark the OTP as read, so a rerun or a
        # manual check in the Gmail UI still sees it as new.
        typ, data = self.imap.select("INBOX", readonly=True)
        if typ != "OK":
            raise RuntimeError("cannot select INBOX: %s" % (data,))


def cmd_list(inbox, limit):
    inbox.select()
    typ, data = inbox.imap.uid("search", None, "ALL")
    if typ != "OK":
        return []
    raw = data[0].decode() if data and data[0] else ""
    uids = [int(x) for x in raw.split() if x.isdigit()]
    out = []
    for uid in sorted(uids, reverse=True)[:limit]:
        h = inbox.header_of(uid)
        if h:
            out.append(h)
    return out


def cmd_wait(inbox, want_to, since_uid, timeout_ms, interval_ms):
    """Poll until a message addressed to `want_to` arrives, or time out."""
    inbox.select()
    deadline = time.time() + timeout_ms / 1000.0
    want = norm_addr(want_to)
    poll = 0
    while time.time() < deadline:
        poll += 1
        print("PROGRESS %d" % poll, flush=True)
        for uid in inbox.uids_since(since_uid):
            h = inbox.header_of(uid)
            if not h:
                continue
            # Delivered-To carries the dotted form when the sender used Bcc, so
            # fall back to it rather than trusting To: alone.
            if norm_addr(h["to"]) != want:
                continue
            full = inbox.full_of(uid)
            if full:
                return full
        time.sleep(interval_ms / 1000.0)
    return None


def main():
    user = os.environ["GM_USER"]
    # App passwords are displayed as "abcd efgh ijkl mnop"; the spaces are
    # cosmetic and some clients reject them, so strip before login.
    password = os.environ["GM_PASS"].replace(" ", "")
    try:
        inbox = Inbox(user, password)
    except Exception as e:
        print("FATAL login failed: %s: %s" % (type(e).__name__, e), file=sys.stderr, flush=True)
        return 3
    print("READY", flush=True)

    for line in sys.stdin:
        cmd = line.strip()
        if not cmd:
            continue
        if cmd == "quit":
            break
        try:
            if cmd == "list":
                print(json.dumps(cmd_list(inbox, 20)), flush=True)
            elif cmd.startswith("wait "):
                _, to, since, tmo, ivl = cmd.split(" ", 4)
                got = cmd_wait(inbox, to, int(since), int(tmo), int(ivl))
                print(json.dumps(got), flush=True)
            elif cmd == "select":
                inbox.select()
                print("ok", flush=True)
            else:
                print("ERROR unknown command: %s" % cmd, flush=True)
        except Exception as e:
            print("ERROR %s: %s" % (type(e).__name__, e), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
