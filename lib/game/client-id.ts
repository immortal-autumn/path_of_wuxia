let sequence = 0;

export function createClientId(prefix = "request") {
  sequence = (sequence + 1) % Number.MAX_SAFE_INTEGER;
  const cryptoObject = globalThis.crypto;
  let randomPart: string;

  if (cryptoObject && typeof cryptoObject.getRandomValues === "function") {
    const values = new Uint32Array(2);
    cryptoObject.getRandomValues(values);
    randomPart = `${values[0].toString(36)}${values[1].toString(36)}`;
  } else {
    randomPart = Math.random().toString(36).slice(2, 14);
  }

  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}-${randomPart}`;
}
