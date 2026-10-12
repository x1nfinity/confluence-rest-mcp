import test from 'node:test';
import assert from 'node:assert/strict';
import { readOfficeAttachment } from '../dist/office.js';

const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
function crc32(bytes) {
  let crc=0xffffffff;
  for(const byte of bytes) {
    crc^=byte;
    for(let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);
  }
  return (crc^0xffffffff)>>>0;
}
function packageEntries(entries) {
  const locals=[],central=[];let offset=0;
  for(const [name,data] of entries) {
    const filename=Buffer.from(name),raw=Buffer.isBuffer(data)?data:Buffer.from(data),crc=crc32(raw);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt32LE(crc,14);local.writeUInt32LE(raw.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(filename.length,26);
    locals.push(local,filename,raw);
    const header=Buffer.alloc(46);header.writeUInt32LE(0x02014b50);header.writeUInt16LE(20,4);header.writeUInt16LE(20,6);header.writeUInt16LE(0x800,8);header.writeUInt32LE(crc,16);header.writeUInt32LE(raw.length,20);header.writeUInt32LE(raw.length,24);header.writeUInt16LE(filename.length,28);header.writeUInt32LE(offset,42);
    central.push(header,filename);offset+=local.length+filename.length+raw.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
function docx(body,extras=[]) {return packageEntries([['word/document.xml',`<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`],...extras]);}
function rejects(raw,code='NOT_SUPPORTED') {assert.throws(()=>readOfficeAttachment(raw,'sample.docx',null),{code});}

test('Office validation rejects malformed XML, entity codepoints and invalid namespaces',()=>{
  for(const body of ['<w:p><w:t>missing close','<w:p></w:body>','<w:p x="1" x="2"/>','<unbound:p/>','<w:p><w:t>&unknown;</w:t></w:p>','<w:p><w:t>&#0;</w:t></w:p>','<w:p><w:t>&#x110000;</w:t></w:p>','<w:p><w:t>&#xD800;</w:t></w:p>']) rejects(docx(body));
  assert.equal(readOfficeAttachment(docx('<w:p><w:t>&#x1F642; &amp; &lt;</w:t></w:p>'),'sample.docx',null).text,'🙂 & <\n');
  assert.equal(readOfficeAttachment(docx('<w:p><w:t>line\r\nnext\rend</w:t></w:p>'),'sample.docx',null).text,'line\nnext\nend\n');
});

test('Office ZIP member integrity and package declarations are checked before extraction',()=>{
  for(const name of ['../secret.xml','/absolute.xml','word/../secret.xml','word//secret.xml','word/./secret.xml','C:/secret.xml','word\\secret.xml']) rejects(docx('<w:p/>',[[name,'data']]));
  rejects(docx('<w:p/>',[['word/document.xml','<duplicate/>']]));
  rejects(docx('<w:p/>',[['word/ignored.xml','<!DOCTYPE a><a/>']]));
  const corrupt=docx('<w:p/>');corrupt[14]^=1;rejects(corrupt);
  rejects(docx('<w:p/>',[['word/vbaProject.bin','data']]));
  const depth='<w:sdt>'.repeat(255)+'</w:sdt>'.repeat(255);rejects(docx(depth),'RESPONSE_TOO_LARGE');
});

test('valid UTF-32 XML remains supported as OpenXML document input',()=>{
  const source=`<w:document xmlns:w="${W}"><w:body><w:p><w:t>中文🙂</w:t></w:p></w:body></w:document>`;
  for(const little of [true,false]) {
    const points=Array.from(source),raw=Buffer.alloc((points.length+1)*4);
    if(little) raw.writeUInt32LE(0xfeff);else raw.writeUInt32BE(0xfeff);
    points.forEach((char,index)=>little?raw.writeUInt32LE(char.codePointAt(0),(index+1)*4):raw.writeUInt32BE(char.codePointAt(0),(index+1)*4));
    assert.equal(readOfficeAttachment(packageEntries([['word/document.xml',raw]]),'sample.docx',null).text,'中文🙂\n');
  }
});
