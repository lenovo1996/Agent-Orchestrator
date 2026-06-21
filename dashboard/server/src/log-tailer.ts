import fs from "node:fs";

/**
 * Đọc incremental log lines từ vị trí offset cuối cùng.
 * Trả về các dòng mới kể từ lần đọc trước và cập nhật offset trong map.
 *
 * @param filePath - Đường dẫn tuyệt đối tới log file
 * @param offsets - Map lưu trữ byte offset đã đọc cho mỗi file
 * @returns Array of new lines (empty nếu không có nội dung mới)
 */
export function readNewLogLines(
  filePath: string,
  offsets: Map<string, number>,
): string[] {
  const currentOffset = offsets.get(filePath) || 0;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    // File không tồn tại hoặc không đọc được → reset offset, trả về empty
    offsets.delete(filePath);
    return [];
  }

  // File bị truncate (nhỏ hơn offset trước) → reset và đọc từ đầu
  if (stat.size < currentOffset) {
    offsets.set(filePath, 0);
    return readNewLogLines(filePath, offsets);
  }

  // Không có nội dung mới
  if (stat.size === currentOffset) {
    return [];
  }

  const bytesToRead = stat.size - currentOffset;
  const buffer = Buffer.alloc(bytesToRead);

  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return [];
  }

  try {
    fs.readSync(fd, buffer, 0, bytesToRead, currentOffset);
  } finally {
    fs.closeSync(fd);
  }

  offsets.set(filePath, stat.size);

  const newContent = buffer.toString("utf8");
  // Split by newline, filter empty trailing entry from split
  return newContent.split("\n").filter((line) => line.length > 0);
}
