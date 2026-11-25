import base64
import hashlib
import hmac
import os
import re
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


PHONE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")
SENSITIVE_LINE = re.compile(r"^\s*(性别|年龄|出生|生日|婚育|婚姻|民族|宗教|政治面貌|籍贯|户籍|身份证|家庭|住址|详细地址|健康|性取向|紧急联系人)\s*[:：]")
FORBIDDEN = re.compile(r"性别|几岁|年龄|出生日期|婚育|结婚|生孩子|民族|宗教|政治面貌|户籍|健康状况|性取向|身份证|限男性|限女性|\d+岁以下")


def redact(text):
    lines = [x for x in text.splitlines() if not SENSITIVE_LINE.search(x)]
    text = "\n".join(lines)
    text = PHONE.sub("[手机号已隐藏]", text)
    text = re.sub(r"(?<!\d)\d{17}[\dXx](?!\d)", "[证件号已隐藏]", text)
    text = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[邮箱已隐藏]", text)
    text = re.sub(r"(微信|QQ|住址|身份证|性别|年龄|婚育)\s*[:：]\s*[^\n，,；;]+", r"\1：[已隐藏]", text)
    return text.strip()


def safe_question(text):
    return isinstance(text, str) and 4 <= len(text) <= 100 and not FORBIDDEN.search(text) and not PHONE.search(text)


class Vault:
    def __init__(self, directory: Path):
        directory.mkdir(parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
        key_path = directory / "local.key"
        if not key_path.exists():
            fd = os.open(str(key_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as file:
                file.write(os.urandom(32))
        self.key = key_path.read_bytes()

    def phone(self, raw):
        # Only explicitly labelled personal contact numbers; never guess a third-party number.
        for line in raw.splitlines():
            if re.search(r"紧急|推荐人|猎头|HR|联系人", line, re.I) and not re.search(r"本人", line):
                continue
            if not re.search(r"手机|电话|本人", line):
                continue
            match = PHONE.search(line)
            if match:
                value = match.group()
                nonce = os.urandom(12)
                encrypted = AESGCM(self.key).encrypt(nonce, value.encode(), b"candidate-phone-v1")
                return {"enc": base64.b64encode(nonce + encrypted).decode(),
                        "hash": hmac.new(self.key, b"phone:" + value.encode(), hashlib.sha256).hexdigest(),
                        "masked": value[:3] + "****" + value[-4:], "verified": False}
        return None

    def reveal(self, record):
        raw = base64.b64decode(record["enc"])
        return AESGCM(self.key).decrypt(raw[:12], raw[12:], b"candidate-phone-v1").decode()

