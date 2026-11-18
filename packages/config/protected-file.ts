import { readFile, realpath, stat, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export async function protectedFile(path:string, privateOnly=false) {
  if(!isAbsolute(path))throw Error('registry.file');
  const metadata=await lstat(path);
  if(!metadata.isFile()||metadata.uid!==0||metadata.mode&(privateOnly?0o077:0o027)||await realpath(path)!==path)throw Error('registry.file');
  // Every ancestor must be root-owned and not group/world writable.
  for(let parent=path.slice(0,path.lastIndexOf('/'))||'/';;parent=parent.slice(0,parent.lastIndexOf('/'))||'/'){
    const directory=await stat(parent);
    if(directory.uid!==0||directory.mode&0o022)throw Error('registry.directory');
    if(parent==='/')break;
  }
  return readFile(path,'utf8');
}
