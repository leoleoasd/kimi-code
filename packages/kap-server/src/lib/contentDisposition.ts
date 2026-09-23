export function buildContentDisposition(
  name: string,
  mediaType?: string,
  options?: { readonly forceAttachment?: boolean },
): string {
  const disposition =
    options?.forceAttachment === true || !/^(image|video|audio)\//.test(mediaType ?? '')
      ? 'attachment'
      : 'inline';
  if (/^[\w. ()+[\]-]+$/.test(name)) {
    return `${disposition}; filename="${name}"`;
  }
  return disposition;
}
