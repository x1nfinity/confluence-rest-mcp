"""Execute original offline fixtures and record their complete Python document results."""
import contextlib
import io
import gzip
import json
from pathlib import Path
import runpy
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'native' / 'src'))
sys.path.insert(0, str(ROOT / 'native' / 'tests'))
from confluence_mcp import document, targeting
from confluence_mcp.browser_bridge import ReadError

records = []
original_parser = document.PageText


class RecordedParser(original_parser):
    def __init__(self, base, page_id, representation='view'):
        super().__init__(base, page_id, representation)
        self.source = ''
        self.representation = representation

    def feed(self, source):
        self.source += source
        return super().feed(source)

    def close(self):
        super().close()
        records.append({'operation': 'parse', 'html': self.source, 'base': self.base,
                        'id': self.page_id, 'representation': self.representation,
                        'expected': {'text': self.text(), **self.structure(),
                                     'sectionRanges': self.section_ranges()}})


document.PageText = RecordedParser


def record(function, operation):
    def call(*args, **kwargs):
        # Python-only float versus integer distinctions do not survive a JSON transport.
        comparable = not any(type(value) is float for value in (*args, *kwargs.values()))
        try:
            comparable = comparable and json.loads(json.dumps([args, kwargs], allow_nan=False)) == [list(args), kwargs]
        except (ValueError, TypeError, RecursionError):
            comparable = False
        try:
            result = function(*args, **kwargs)
        except ReadError as error:
            if comparable:
                records.append({'operation': operation, 'args': args, 'options': kwargs,
                                'error': error.code})
            raise
        if comparable:
            records.append({'operation': operation, 'args': args, 'options': kwargs,
                            'expected': result})
        return result
    return call


for name in ('section_chunk', 'find_text', 'validate_find', 'validate_section'):
    setattr(targeting, name, record(getattr(targeting, name), name))
document.structure_chunk = record(document.structure_chunk, 'structure_chunk')
with contextlib.redirect_stdout(io.StringIO()):
    runpy.run_path(str(ROOT / 'native/tests/test_document.py'), run_name='__main__')
    runpy.run_path(str(ROOT / 'native/tests/test_targeting.py'), run_name='__main__')
    runpy.run_path(str(ROOT / 'native/tests/test_structure_stream.py'), run_name='__main__')
    extra = RecordedParser('https://example.com/confluence', '123')
    extra.feed('<h1>🙂e\u0301中</h1><p><a href="/中文?q=中#🙂">中文链接</a></p>')
    extra.close()
sys.stdout.buffer.write(gzip.compress(json.dumps(records, ensure_ascii=True, separators=(',', ':')).encode('utf-8')))
