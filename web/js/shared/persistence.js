export function dateStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function downloadResponseBlob(response, filename) {
  if (!response?.ok) {
    return false;
  }
  downloadBlob(await response.blob(), filename);
  return true;
}
