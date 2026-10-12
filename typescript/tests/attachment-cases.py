"""Export synthetic inputs and expected outputs exercised by the Python baseline."""
import base64
import contextlib
import io
import json
from pathlib import Path
import runpy
import sys

root = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(root / 'native/tests'), str(root / 'native/src')]
from confluence_mcp import office_documents, text_attachments, excel_formats
from confluence_mcp.browser_bridge import ReadError

cases = []
original_zip = office_documents.zipfile.ZipFile


def capture(module, name, kind):
    original = getattr(module, name)

    def wrapped(*args, **kwargs):
        record = kind != 'excel' or sys._getframe(1).f_code.co_filename.endswith('test_excel_formats.py')
        record &= office_documents.zipfile.ZipFile is original_zip
        values = list(args)
        if kind != 'excel':
            values[0] = {'bytes': base64.b64encode(values[0]).decode()} if isinstance(values[0], bytes) else values[0]
        try:
            result = original(*args, **kwargs)
        except ReadError as error:
            if record:
                cases.append({'kind': kind, 'args': values, 'kwargs': kwargs, 'error': error.code})
            raise
        if record:
            cases.append({'kind': kind, 'args': values, 'kwargs': kwargs, 'result': result})
        return result

    setattr(module, name, wrapped)


capture(text_attachments, 'read_text_attachment', 'text')
capture(office_documents, 'read_office_attachment', 'office')
capture(excel_formats, 'display_number', 'excel')
with contextlib.redirect_stdout(io.StringIO()):
    for test in ('test_text_attachments.py', 'test_office_documents.py', 'test_excel_formats.py'):
        runpy.run_path(str(root / 'native/tests' / test))
print(json.dumps(cases, ensure_ascii=False))
