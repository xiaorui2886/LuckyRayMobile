// Never publish raw native errors: a pairing failure may contain its payload.
export function safeError(raw) {
 const value=String(raw??'');
 if(/token|secret|password|authorization|credential|jwt|cookie|bearer|pairing|payload|\bfp\b/i.test(value))return 'Sensitive native diagnostic withheld';
 return value.slice(0,1000);
}
