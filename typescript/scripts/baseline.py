"""Freeze or check managed Python source, contracts and synthetic read fixtures."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / 'typescript'
sys.path.insert(0, str(ROOT / 'native/src'))
from confluence_mcp.server import TOOLS
from confluence_mcp.document import PageText
from confluence_mcp.browser_bridge import ERRORS
from confluence_mcp.write_preview import preview_hash


def snapshot():
    native = ROOT / 'native'
    release = json.loads((native / 'release.json').read_text())
    declared = dict(release['files'])
    files = {name: hashlib.sha256((native / name).read_bytes()).hexdigest() for name in declared}
    for name in ('release.json', 'scripts/check.py', 'docs/development.md'):
        files[name] = hashlib.sha256((native / name).read_bytes()).hexdigest()
    cases = [
        ('plain', '<h1 id="intro">简介😀</h1><p>Alpha &amp; 中文</p><p>第二段</p>'),
        ('lists', '<ol><li>一<ul><li>二</li></ul></li><li>三</li></ol>'),
        ('links', '<p><a href="/confluence/display/DEMO/Plan">计划</a><img alt="图" src="/confluence/img.png"></p>'),
        ('strike', '<p>现行<del>旧规则</del><span style="text-decoration: line-through">废弃</span></p>'),
        ('pre', '<pre> a\n  b</pre><script>hidden</script><p>可读</p>'),
        ('table_text', '<table><tr><th>名称</th><th>值</th></tr><tr><td>A</td><td>1</td></tr></table>'),
        ('long_unicode', '<p>' + '中文😀abc' * 260 + '</p>'),
    ]
    fixtures = []
    for name, html in cases:
        parser = PageText('https://example.com/confluence', '123')
        parser.feed(html); parser.close()
        fixtures.append({'name': name, 'html': html, 'text': parser.text(),
                         'sections': parser.structure()['sections']})
    payload = {'type': 'page', 'title': '中文😀',
               'body': {'storage': {'representation': 'storage', 'value': '<p>内容</p>'}},
               'space': {'key': 'DEMO'}, 'status': 'current'}
    return {'version': release['version'], 'files': files,
            'preexisting_release_mismatches': [name for name in declared if declared[name] != files[name]], 'tools': TOOLS,
            'errors': ERRORS, 'fixtures': fixtures,
            'preview_vector': {'base': 'https://example.com/confluence', 'method': 'POST',
                               'path': 'content', 'payload': payload,
                               'hash': preview_hash('https://example.com/confluence', 'POST', 'content', payload)}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    data = json.loads(json.dumps(snapshot(), ensure_ascii=False))
    path = TARGET / 'baseline/python-0.14.0.json'
    contracts = {'tools': data['tools'], 'errors': data['errors']}
    if args.check:
        assert json.loads(path.read_text()) == data, 'Frozen baseline differs'
        assert json.loads((TARGET / 'src/contracts.json').read_text()) == contracts, 'Contracts differ'
        print('Python 0.14.0 baseline unchanged; 12 tools and synthetic fixtures match')
    else:
        assert not path.exists(), 'Baseline already exists; never replace silently'
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
        print('Frozen managed files, 12 tools, errors, text fixtures and preview vector')


if __name__ == '__main__':
    main()
