// Array filters use repeated, unbracketed keys (OpenAPI explode: true).
export function parameterEntries(params) {
  return Object.keys(params).sort().flatMap(key => {
    const values = Array.isArray(params[key]) ? params[key] : [params[key]];
    return values.filter(value => value != null).map(value => [key, String(value)]);
  });
}

export function serializeQuery(params) {
  return new URLSearchParams(parameterEntries(params)).toString();
}
