/**
 * Multer 在部分客户端上会把 multipart 文件名按 Latin1 传入。
 * 只对有明显乱码特征的名称尝试恢复，避免破坏已经正确的中文名称。
 */
export function normalizeOriginalFileName(fileName: string): string {
  if (!looksLikeMojibake(fileName)) return fileName;

  try {
    const decoded = Buffer.from(fileName, 'latin1').toString('utf8');
    if (decoded.includes('\uFFFD') || !Array.from(decoded).some((char) => char.charCodeAt(0) > 0x7f)) return fileName;
    return decoded;
  } catch {
    return fileName;
  }
}

function looksLikeMojibake(fileName: string): boolean {
  // Replacement/control characters and common UTF-8-as-Latin1 prefixes.
  return fileName.includes('\uFFFD')
    || Array.from(fileName).some((char) => {
      const code = char.charCodeAt(0);
      return code === 0x7f || (code >= 0 && code <= 0x1f);
    })
    || /(?:Ã|Â|â|å|æ|ç|è|é|ê|ë|ì|í|î|ï|ð|ñ|ò|ó|ô|õ|ö|÷|ø|ù|ú|û|ü|ý|þ)[\u0080-\u00BF]/u.test(fileName);
}
