"""Document extraction reused from 简历候选Agent."""
import base64
import io
import zipfile
from pathlib import Path
from fastapi import HTTPException
from .service import require


def extract_file(payload):
    from docx import Document
    from pypdf import PdfReader
    try:
        raw = base64.b64decode(payload.content, validate=True)
        require(len(raw) <= 10 * 1024 * 1024, "文件超过10MB", 413)
        suffix = Path(payload.name).suffix.lower()
        if suffix == ".pdf":
            require(raw.startswith(b"%PDF"), "文件内容不是PDF", 422)
            reader = PdfReader(io.BytesIO(raw))
            require(not reader.is_encrypted, "PDF已加密，请取消密码后重试", 422)
            require(len(reader.pages) <= 30, "PDF超过30页，请提供简历部分", 422)
            text = "\n".join(page.extract_text() or "" for page in reader.pages)
        elif suffix == ".docx":
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                require(sum(z.file_size for z in archive.infolist()) <= 30 * 1024 * 1024, "DOCX解压内容过大", 422)
            document = Document(io.BytesIO(raw))
            text = "\n".join([p.text for p in document.paragraphs] + [" / ".join(c.text for c in r.cells) for t in document.tables for r in t.rows])
        elif suffix == ".txt":
            text = raw.decode("utf-8-sig")
        else:
            raise HTTPException(422, "支持文本PDF、DOCX、UTF-8 TXT；扫描件或图片请先转为文字")
        require(20 <= len(text) <= 50000, "未取得足够文字或内容过长；扫描PDF请转为文字或粘贴简历正文", 422)
        return {"text": text}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(422, "文件无法解析，请检查格式、密码或改用粘贴文字")
