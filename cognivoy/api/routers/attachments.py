"""HTTP endpoint for chat attachment downloads / previews.

The chat turn runtime persists every uploaded attachment to the
:class:`~cognivoy.services.storage.AttachmentStore` and records the public
URL on the message. The frontend preview drawer loads files via this
router, which only serves paths the store hands back — every component is
sanitised to defend against directory traversal.

URL shape::

    GET /api/attachments/{session_id}/{attachment_id}/{filename}

The session id functions as the ACL boundary, mirroring how the rest of
the app treats sessions today (single-tenant, session ownership is local
trust). Once multi-user auth lands we should swap this for signed URLs.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from cognivoy.api.file_delivery import content_disposition, untrusted_file_policy
from cognivoy.services.storage import (
    LocalDiskAttachmentStore,
    get_attachment_store,
)

logger = logging.getLogger(__name__)

router = APIRouter()


def _content_disposition(filename: str, *, disposition: str = "inline") -> str:
    """Build a Content-Disposition header that survives non-ASCII filenames.

    HTTP/1.1 headers are latin-1, so dropping a Chinese / accented filename
    straight into ``filename="..."`` blows up with UnicodeEncodeError. RFC
    6266 / RFC 5987 cover this: emit ``filename*=UTF-8''<percent-encoded>``
    plus an ASCII fallback on ``filename=`` for legacy clients.
    """
    return content_disposition(filename, disposition)


@router.get("/{session_id}/{attachment_id}/{filename:path}")
async def get_attachment(
    session_id: str,
    attachment_id: str,
    filename: str,
):
    """Serve a previously uploaded chat attachment.

    Responds with ``Content-Disposition: inline`` so browsers preview PDFs
    and images directly in an ``<iframe>`` / ``<img>``. For unknown types
    the browser still falls back to download, which is fine for the
    drawer's "Download" button path.
    """
    store = get_attachment_store()
    if not isinstance(store, LocalDiskAttachmentStore):
        # Future remote backends should issue a redirect to the signed URL
        # here. Local-disk is the only backend today, so this branch just
        # guards against an unexpected configuration.
        raise HTTPException(status_code=501, detail="Attachment backend not servable")

    target = store.resolve_path(
        session_id=session_id,
        attachment_id=attachment_id,
        filename=filename,
    )
    if target is None:
        raise HTTPException(status_code=404, detail="Attachment not found")

    media_type, disposition, headers = untrusted_file_policy(target)
    headers["Content-Disposition"] = _content_disposition(target.name, disposition=disposition)
    return FileResponse(path=str(target), media_type=media_type, headers=headers)
