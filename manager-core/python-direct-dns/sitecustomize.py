import ipaddress
import os
import random
import socket
import struct
import time

_ORIGINAL_GETADDRINFO = socket.getaddrinfo
_CACHE = {}
_FAKE_NETS = (
    ipaddress.ip_network("198.18.0.0/15"),
)
_FALLBACK_A_RECORDS = {
    "www.modelscope.cn": ["39.99.133.195", "47.92.141.220"],
    "modelscope.cn": ["39.99.133.195", "47.92.141.220"],
}


def _enabled():
    return os.environ.get("MODELSCOPE_DIRECT_DNS", "0").strip().lower() in ("1", "true", "yes")


def _dns_servers():
    configured = os.environ.get("MODELSCOPE_DIRECT_DNS_SERVERS", "")
    servers = [item.strip() for item in configured.split(",") if item.strip()]
    return servers or ["223.5.5.5", "119.29.29.29", "1.1.1.1"]


def _host_text(host):
    if isinstance(host, bytes):
        return host.decode("ascii", "ignore")
    return str(host or "")


def _is_ip(value):
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def _is_fake_ip(value):
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return False
    return any(ip in network for network in _FAKE_NETS)


def _system_returns_only_fake(host):
    try:
        infos = _ORIGINAL_GETADDRINFO(host, 443, socket.AF_INET, socket.SOCK_STREAM)
    except socket.gaierror:
        return True
    ips = [info[4][0] for info in infos if info and info[4]]
    return bool(ips) and all(_is_fake_ip(ip) for ip in ips)


def _dns_query_a(host, server, timeout=2.0):
    query_id = random.randint(0, 65535)
    labels = host.rstrip(".").split(".")
    question = b"".join(bytes([len(label)]) + label.encode("ascii") for label in labels) + b"\x00"
    packet = struct.pack("!HHHHHH", query_id, 0x0100, 1, 0, 0, 0) + question + struct.pack("!HH", 1, 1)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(packet, (server, 53))
        data, _addr = sock.recvfrom(4096)
    finally:
        sock.close()
    if len(data) < 12:
        return []
    response_id, _flags, qdcount, ancount, _nscount, _arcount = struct.unpack("!HHHHHH", data[:12])
    if response_id != query_id:
        return []
    offset = 12
    for _ in range(qdcount):
        offset = _skip_name(data, offset) + 4
    records = []
    for _ in range(ancount):
        offset = _skip_name(data, offset)
        if offset + 10 > len(data):
            return records
        rtype, rclass, _ttl, rdlength = struct.unpack("!HHIH", data[offset:offset + 10])
        offset += 10
        rdata = data[offset:offset + rdlength]
        offset += rdlength
        if rtype == 1 and rclass == 1 and rdlength == 4:
            records.append(socket.inet_ntoa(rdata))
    return records


def _skip_name(data, offset):
    while offset < len(data):
        length = data[offset]
        if length & 0xC0 == 0xC0:
            return offset + 2
        offset += 1
        if length == 0:
            return offset
        offset += length
    return offset


def _resolve_direct(host):
    now = time.time()
    cached = _CACHE.get(host)
    if cached and cached[0] > now:
        return cached[1]
    for server in _dns_servers():
        try:
            records = [ip for ip in _dns_query_a(host, server) if not _is_fake_ip(ip)]
        except OSError:
            records = []
        if records:
            _CACHE[host] = (now + 300, records)
            return records
    records = _FALLBACK_A_RECORDS.get(host, [])
    if records:
        _CACHE[host] = (now + 60, records)
    return records


def _patched_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    text = _host_text(host).strip().rstrip(".").lower()
    if not _enabled() or not text or _is_ip(text) or text == "localhost":
        return _ORIGINAL_GETADDRINFO(host, port, family, type, proto, flags)
    if not _system_returns_only_fake(text):
        return _ORIGINAL_GETADDRINFO(host, port, family, type, proto, flags)
    records = _resolve_direct(text)
    if not records:
        return _ORIGINAL_GETADDRINFO(host, port, family, type, proto, flags)
    results = []
    requested_family = family if family in (socket.AF_INET, socket.AF_UNSPEC, 0) else socket.AF_INET
    for ip in records:
        try:
            results.extend(_ORIGINAL_GETADDRINFO(ip, port, requested_family, type, proto, flags))
        except socket.gaierror:
            continue
    return results or _ORIGINAL_GETADDRINFO(host, port, family, type, proto, flags)


socket.getaddrinfo = _patched_getaddrinfo
