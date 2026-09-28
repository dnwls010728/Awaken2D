// Browser stand-in for node:fs. The editor never touches the disk directly (the server does);
// only existence checks used by validation are answered, optimistically.
const unsupported = (name) => () => {
  throw new Error(`fs.${name} is not available in the browser`);
};
export const existsSync = () => true;
export const readFileSync = unsupported("readFileSync");
export const writeFileSync = unsupported("writeFileSync");
export const mkdirSync = unsupported("mkdirSync");
export const readdirSync = unsupported("readdirSync");
export const statSync = unsupported("statSync");
