#!/usr/bin/env python3
"""
process_spools.py - Watches spool folder and organizes messages into chat logs.
Groups by channelKey from JSON, ignores folder structure.
"""

import json
import re
import time
from pathlib import Path
from datetime import datetime
from collections import defaultdict

# =============================================================================
# CONFIGURATION
# =============================================================================

def load_config():
    config = {
        'spool_dir': Path.home() / "Downloads" / "Browsesaver" / "spool",
        'logs_dir': Path.home() / "Documents" / "DiscordLogs" / "full",
        'embeddings_dir': Path.home() / "Documents" / "DiscordLogs" / "embeddings",
        'poll_interval': 2.0,
        'min_message_length': 2,
    }
    
    config_path = Path(__file__).parent / "config.yaml"
    if config_path.exists():
        try:
            with open(config_path, 'r') as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith('#'):
                        continue
                    if ':' in line:
                        key, value = line.split(':', 1)
                        key, value = key.strip(), value.strip()
                        
                        if value.lower() == 'true': value = True
                        elif value.lower() == 'false': value = False
                        elif value.replace('.', '').isdigit():
                            value = float(value) if '.' in value else int(value)
                        elif value.startswith('~'):
                            value = Path.home() / value[2:]
                        
                        if key in config:
                            config[key] = value
                            if key.endswith('_dir') and not isinstance(config[key], Path):
                                config[key] = Path(config[key])
        except Exception as e:
            print(f"Config error: {e}")
    
    return config

CONFIG = load_config()
SPOOL_DIR = CONFIG['spool_dir']
LOGS_DIR = CONFIG['logs_dir']
EMBED_DIR = CONFIG['embeddings_dir']
POLL_INTERVAL = CONFIG['poll_interval']
MIN_MSG_LEN = CONFIG['min_message_length']

# =============================================================================
# State
# =============================================================================

# channelKey -> { messageId -> message }
all_messages: dict[str, dict[str, dict]] = defaultdict(dict)

# Track files we've already loaded
loaded_files: set[str] = set()

# =============================================================================
# Helpers
# =============================================================================

def sanitize_filename(s: str) -> str:
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', s)
    s = re.sub(r'\s+', ' ', s).strip()
    # Remove (1), (2) etc suffixes that browsers add
    s = re.sub(r'\s*\(\d+\)\s*$', '', s)
    return s[:100] if s else "unknown"


def clean_content(text: str) -> str:
    if not text: return ""
    text = re.sub(
        r'\s*\(edited\)\s*\n?\s*(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+'
        r'(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+'
        r'\d{1,2},\s+\d{4}\s+at\s+\d{1,2}:\d{2}\s*(?:AM|PM)',
        '', text, flags=re.IGNORECASE
    )
    return re.sub(r'\s*\(edited\)\s*$', '', text).strip()


def is_dm(guild_id: str) -> bool:
    return guild_id == "@me"


def is_lmarena(guild_id: str) -> bool:
    return guild_id == "lmarena"


def parse_channel_info(raw_name: str, guild_id: str) -> tuple[str, str, bool]:
    name = raw_name.strip()
    
    if is_dm(guild_id):
        username = re.sub(r'^[@#]|Direct Message(s)? (with )?', '', name).strip()
        return ("Direct Messages", sanitize_filename(username or "unknown"), True)
    
    if is_lmarena(guild_id):
        clean_name = name.replace("LMArena - ", "")
        return ("LMArena", sanitize_filename(clean_name or "chat"), False)
    
    parts = [p.strip() for p in name.split("|")]
    if len(parts) >= 3:
        return (sanitize_filename(parts[2]), sanitize_filename(parts[1].lstrip("#• ")), False)
    elif len(parts) == 2:
        return (sanitize_filename(parts[1]), sanitize_filename(parts[0].lstrip("#• ")), False)
    
    return (sanitize_filename(guild_id or "unknown"), sanitize_filename(name or "general"), False)


def format_timestamp(ms: int, is_arena: bool = False) -> str:
    if is_arena:
        return f"[turn {ms:03d}]"
    if not ms or ms <= 0:
        return "[unknown time]"
    try:
        return datetime.fromtimestamp(ms / 1000).strftime("[%Y-%m-%d %H:%M]")
    except:
        return "[unknown time]"


# =============================================================================
# Loading & Ingesting
# =============================================================================


def normalize_channel_key(msg: dict) -> str:
    """Get channel key without threadId - just guildId:channelId."""
    guild_id = msg.get("guildId", "")
    channel_id = msg.get("channelId", "")
    return f"{guild_id}:{channel_id}"

def load_ndjson_file(path: Path) -> list[dict]:
    messages = []
    try:
        with open(path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        messages.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
    except Exception as e:
        print(f"  Error reading {path.name}: {e}")
    return messages


def ingest_messages(messages: list[dict]) -> set[str]:
    """Ingest messages, return set of affected channelKeys."""
    affected = set()
    
    for msg in messages:
        message_id = msg.get("messageId")
        if not message_id:
            continue
        
        # Use normalized key (without threadId) to group conversations
        channel_key = normalize_channel_key(msg)
        if not channel_key or channel_key == ":":
            continue
        
        existing = all_messages[channel_key].get(message_id)
        
        if not existing:
            all_messages[channel_key][message_id] = msg
            affected.add(channel_key)
        else:
            # Re-ingest on meaningful changes
            new_len = len(msg.get("contentText", ""))
            old_len = len(existing.get("contentText", ""))
            content_grew = new_len > old_len
            more_attachments = len(msg.get("attachments", [])) > len(existing.get("attachments", []))
            reactions_changed = msg.get("reactions") != existing.get("reactions")
            newly_edited = msg.get("edited") and not existing.get("edited")
            gained_reply = msg.get("replyTo") and not existing.get("replyTo")
            if content_grew or more_attachments or reactions_changed or newly_edited or gained_reply:
                all_messages[channel_key][message_id] = {**existing, **msg}
                affected.add(channel_key)
    
    return affected


def load_all_spools() -> set[str]:
    """Load ALL spool files, return affected channelKeys."""
    if not SPOOL_DIR.exists():
        print(f"Spool directory not found: {SPOOL_DIR}")
        return set()
    
    all_files = list(SPOOL_DIR.rglob("*.ndjson"))
    if not all_files:
        print("No spool files found")
        return set()
    
    print(f"Loading {len(all_files)} spool file(s)...")
    
    affected = set()
    total_msgs = 0
    
    for f in all_files:
        file_key = str(f)
        if file_key in loaded_files:
            continue
        
        loaded_files.add(file_key)
        messages = load_ndjson_file(f)
        
        if messages:
            new_affected = ingest_messages(messages)
            affected.update(new_affected)
            total_msgs += len(messages)
    
    # Dedupe stats
    unique_msgs = sum(len(msgs) for msgs in all_messages.values())
    print(f"Loaded {total_msgs} messages, {unique_msgs} unique across {len(all_messages)} channels")
    
    return affected


# =============================================================================
# Sorting & Processing
# =============================================================================

def get_sorted_messages(channel_key: str) -> list[dict]:
    msgs = list(all_messages[channel_key].values())
    
    is_arena = any(m.get("guildId") == "lmarena" or m.get("source") == "lmarena" for m in msgs)
    
    if is_arena:
        def arena_key(m):
            if m.get("turnIndex"): return m["turnIndex"]
            match = re.search(r'-(\d+)$', m.get("messageId", ""))
            return int(match.group(1)) if match else 0
        msgs.sort(key=arena_key)
    else:
        msgs.sort(key=lambda m: (m.get("timestampMs", 0), m.get("messageId", "")))
    
    return msgs


def resolve_authors(msgs: list[dict]) -> list[dict]:
    resolved = []
    last_known = None
    
    for msg in msgs:
        author = msg.get("author", "Unknown")
        if author == "Unknown" and last_known:
            msg = {**msg, "author": last_known}
        elif author != "Unknown":
            last_known = author
        resolved.append(msg)
    
    return resolved


def get_channel_metadata(channel_key: str) -> tuple[str, str, str, bool]:
    """Get (location, channel, currentUser, isDM) from messages."""
    msgs = list(all_messages.get(channel_key, {}).values())
    if not msgs:
        # Fallback
        parts = channel_key.split(":")
        return ("unknown", "unknown", "unknown", False)
    
    raw_name = ""
    guild_id = ""
    current_user = "unknown"
    
    # Find a message with good metadata
    for m in msgs:
        if m.get("channelName") and not raw_name:
            raw_name = m["channelName"]
        if m.get("guildId") and not guild_id:
            guild_id = m["guildId"]
        if m.get("currentUser") and current_user == "unknown":
            current_user = m["currentUser"]
        
        if raw_name and guild_id and current_user != "unknown":
            break
    
    if not raw_name and not guild_id:
        # Fallback: parse from channelKey
        parts = channel_key.split(":")
        guild_id = parts[0] if parts else "unknown"
        raw_name = channel_key
    
    location, channel, is_direct = parse_channel_info(raw_name, guild_id)
    return location, channel, current_user, is_direct


# =============================================================================
# Writing Output
# =============================================================================

def write_full_log(msgs: list[dict], location: str, channel: str) -> Path:
    out_dir = LOGS_DIR / location
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"{channel}.txt"
    
    is_arena = any(m.get("guildId") == "lmarena" for m in msgs)
    
    lines = []
    for msg in msgs:
        ts = format_timestamp(msg.get("timestampMs", 0), is_arena=is_arena)
        author = msg.get("author", "Unknown")
        content = clean_content(msg.get("contentText", ""))
        
        header = f"{ts} {author}"
        if msg.get("edited"):
            header += " (edited)"
        lines.append(header)
        
        reply_to = msg.get("replyTo")
        if reply_to:
            reply_author = reply_to.get("author", "Unknown")
            reply_content = reply_to.get("content", "")
            if reply_content:
                preview = reply_content[:150] + ("..." if len(reply_content) > 150 else "")
                lines.append(f"  > replying to {reply_author}: {preview}")
            else:
                lines.append(f"  > replying to {reply_author}")
        
        if content:
            lines.append(content)
        
        for att in msg.get("attachments", []):
            fn = att.get("filename", "")
            url = att.get("url", "")
            if url and any(x in url for x in ["avatar", "badge", "decoration"]):
                continue
            if fn:
                lines.append(f"  [Attachment: {fn}]")
        
        reactions = msg.get("reactions", [])
        if reactions:
            reaction_strs = [f"{r.get('emoji', '?')} x{r.get('count', 1)}" for r in reactions]
            lines.append(f"  [Reactions: {', '.join(reaction_strs)}]")
        
        lines.append("")
    
    out_file.write_text("\n".join(lines), encoding='utf-8')
    return out_file


def write_embedding_log(msgs: list[dict], location: str, channel: str, 
                        current_user: str, is_direct: bool, full_log_path: Path):
    EMBED_DIR.mkdir(parents=True, exist_ok=True)
    out_file = EMBED_DIR / f"{current_user}-{location}-{channel}.txt"
    
    if not is_direct:
        out_file.write_text(full_log_path.read_text(encoding='utf-8'), encoding='utf-8')
    else:
        blocks = []
        current_block = []
        last_author = None
        
        for msg in msgs:
            content = clean_content(msg.get("contentText", ""))
            if not content or len(content) < MIN_MSG_LEN:
                continue
            
            author = msg.get("author", "Unknown")
            
            if last_author is not None and author != last_author:
                if current_block:
                    blocks.append("\n".join(current_block))
                    current_block = []
            
            current_block.append(re.sub(r'\n{2,}', '\n\n', content.strip()))
            last_author = author
        
        if current_block:
            blocks.append("\n".join(current_block))
        
        out_file.write_text("\n\n\n".join(blocks), encoding='utf-8')


def process_channel(channel_key: str):
    msgs = get_sorted_messages(channel_key)
    if not msgs:
        return
    
    msgs = resolve_authors(msgs)
    location, channel, current_user, is_direct = get_channel_metadata(channel_key)
    
    print(f"  {location}/{channel}: {len(msgs)} messages")
    
    full_path = write_full_log(msgs, location, channel)
    write_embedding_log(msgs, location, channel, current_user, is_direct, full_path)


def process_all_channels():
    print(f"\nWriting {len(all_messages)} channel(s)...")
    for channel_key in all_messages:
        process_channel(channel_key)


# =============================================================================
# Watch Loop
# =============================================================================

def scan_for_new_files() -> set[str]:
    """Check for new spool files, return affected channelKeys."""
    if not SPOOL_DIR.exists():
        return set()
    
    affected = set()
    
    for f in SPOOL_DIR.rglob("*.ndjson"):
        file_key = str(f)
        if file_key in loaded_files:
            continue
        
        loaded_files.add(file_key)
        messages = load_ndjson_file(f)
        
        if messages:
            new_affected = ingest_messages(messages)
            affected.update(new_affected)
            print(f"  New: {f.name} ({len(messages)} msgs)")
    
    return affected


def main():
    print(f"Browsesaver Spool Processor")
    print(f"{'='*50}")
    print(f"Spool: {SPOOL_DIR}")
    print(f"Logs:  {LOGS_DIR}")
    print(f"Embed: {EMBED_DIR}")
    print(f"\nMessages grouped by channelKey (folder structure ignored)")
    print(f"Spools kept forever, reloaded on startup")
    print(f"Press Ctrl+C to stop.\n")
    
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    EMBED_DIR.mkdir(parents=True, exist_ok=True)
    
    # Load everything on startup
    affected = load_all_spools()
    if affected:
        process_all_channels()
    
    print(f"\nWatching for new spools...")
    
    try:
        while True:
            time.sleep(POLL_INTERVAL)
            affected = scan_for_new_files()
            if affected:
                for ck in affected:
                    process_channel(ck)
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()