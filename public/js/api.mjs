export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

export async function api(method, path, { body, token, query } = {}) {
  const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null))}` : '';
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['x-member-token'] = token;

  let res;
  try {
    res = await fetch(path + qs, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ApiError("Can't reach PadosiSafe right now. Check your connection. In an emergency, call 112.", 0);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const message = data && data.error ? data.error : `Something went wrong (error ${res.status}). Please try again.`;
    throw new ApiError(message, res.status);
  }
  return data;
}
