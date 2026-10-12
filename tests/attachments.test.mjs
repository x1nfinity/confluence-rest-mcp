import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTextAttachment, readAttachment, isTextAttachment } from '../dist/attachments.js';
import { readOfficeAttachment, isOfficeAttachment } from '../dist/office.js';
import { displayNumber } from '../dist/excel-formats.js';

test('text, DOCX, XLSX and formats match every synthetic Python baseline input', () => {
  const cases=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/attachments.json.gz',import.meta.url))).toString('utf8'));
  const counts={text:0,office:0,excel:0};
  for(const item of cases) {
    counts[item.kind]++;
    let actual;
    try {
      const args=item.args;
      if(item.kind==='excel') actual=displayNumber(args[0],args[1],args[2]??false);
      else {
        const raw=args[0]?.bytes!==undefined?Buffer.from(args[0].bytes,'base64'):args[0];
        const fn=item.kind==='text'?readTextAttachment:readOfficeAttachment;
        actual=fn(raw,args[1],args[2],item.kwargs.text_offset??args[3]??0,item.kwargs.max_text_chars??args[4]??12000);
      }
    } catch(error) {
      assert.ok(item.error,`${item.kind} case ${counts[item.kind]} unexpected exception`);
      assert.equal(error.code,item.error,`${item.kind} case ${counts[item.kind]} error`);continue;
    }
    assert.equal(item.error,undefined,`${item.kind} case ${counts[item.kind]} should reject`);
    assert.deepEqual(actual,item.result,`${item.kind} case ${counts[item.kind]}`);
  }
  assert.ok(counts.text>80 && counts.office>100 && counts.excel>50,JSON.stringify(counts));
});

test('text and Office type gates retain suffix and declared media rules',()=>{
  for(const name of ['notes.TXT','readme.md','sheet.csv','sample.json','query.sql','server.log','config.yaml','config.yml','readme.markdown']) assert.equal(isTextAttachment(name,null),true);
  for(const name of ['archive.zip','page.html','program.js','script.py','book.docx']) assert.equal(isTextAttachment(name,null),false);
  for(const name of ['sample.docx','sample.DOCX','sample.xlsx','sample.XLSX']) assert.equal(isOfficeAttachment(name,null),true);
  for(const name of ['sample.doc','sample.xls','sample.xlsm','sample.docm']) assert.equal(isOfficeAttachment(name,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),false);
});

test('attachments return MCP images, embedded PDF and bounded text evidence',async()=>{
  const png=Buffer.from([137,80,78,71,13,10,26,10]);
  const image=await readAttachment(png,{name:'image.png'});
  assert.deepEqual(image._content,[{type:'image',mimeType:'image/png',data:png.toString('base64')}]);
  assert.equal(image.content_read,true);
  await assert.rejects(readAttachment(png,{name:'image.png'},{max_text_chars:20}),{code:'INVALID_ARGUMENT'});
  const pdf=await readAttachment(Buffer.from('%PDF-1.7 mock'),{name:'sample.pdf',download_url:'https://example.invalid/confluence/download/attachments/1/sample.pdf?version=1'});
  assert.equal(pdf._content[0].type,'resource');assert.equal(pdf._content[0].resource.mimeType,'application/pdf');
  assert.ok(pdf.warnings.some(w=>w.code==='pdf_scope_limited'));
  assert.ok(pdf.text_status||pdf.text_scope);assert.equal(pdf.content?.is_full_document,undefined);
  const text=await readAttachment(Buffer.from('中🙂文'),{name:'sample.txt',media_type:'text/plain'},{text_offset:1,max_text_chars:1});
  assert.equal(text.text,'🙂');assert.equal(text.content.next_offset,2);
});

test('optional PDF extraction bounds Unicode text and reports unavailable capability',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'confluence-pdf-fixture-')),previous=process.env.PATH;
  try {
    process.env.PATH=directory;
    const metadata={name:'sample.pdf',download_url:'https://example.invalid/confluence/download/attachments/1/sample.pdf?version=1'};
    const missing=await readAttachment(Buffer.from('%PDF-1.7'),metadata);
    assert.ok(missing.warnings.some(w=>w.code==='pdf_text_unavailable'));assert.ok(missing._content[0].resource.blob);
    const converter=join(directory,'pdftotext');
    writeFileSync(converter,`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write('🙂'.repeat(40000)));\n`);chmodSync(converter,0o700);
    const result=await readAttachment(Buffer.from('%PDF-1.7'),metadata);
    assert.equal(Array.from(result.text).length,30000);assert.ok(result.text_scope.includes('20'));assert.equal(result.content?.is_full_document,undefined);
    assert.equal(result.warnings.some(w=>w.code==='pdf_text_unavailable'),false);
  } finally {if(previous===undefined) delete process.env.PATH;else process.env.PATH=previous;rmSync(directory,{recursive:true,force:true});}
});
