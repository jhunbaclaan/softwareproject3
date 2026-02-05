export async function healthCheck(): Promise<{ status: string }> {
  const res = await fetch('http://127.0.0.1:8000/health');
  return res.json();
}
