import type { Partition } from "../partition";

export const LITTLEFS_DEFAULT_BLOCK_SIZE = 4096;
export const LITTLEFS_BLOCK_SIZE_CANDIDATES = [4096, 2048, 1024, 512];
export const FATFS_DEFAULT_BLOCK_SIZE = 4096;
export const FATFS_BLOCK_SIZE_CANDIDATES = [4096, 2048, 1024, 512];

// ESP8266-specific parameters
export const ESP8266_LITTLEFS_BLOCK_SIZE = 8192;
export const ESP8266_LITTLEFS_BLOCK_SIZE_CANDIDATES = [8192, 4096];
export const ESP8266_LITTLEFS_PAGE_SIZE = 256;
export const ESP8266_LITTLEFS_BLOCK_SIZE_FOR_FS = 8192;
export const ESP8266_SPIFFS_PAGE_SIZE = 256;
export const ESP8266_SPIFFS_BLOCK_SIZE = 8192;

/**
 * ESP8266 filesystem layout information
 */
export interface ESP8266FilesystemLayout {
  start: number;
  end: number;
  size: number;
  page: number;
  block: number;
}

/**
 * Calculate ESP8266 filesystem layout based on flash size
 * This mimics the logic from platform-espressif8266/builder/main.py _parse_ld_sizes()
 * 
 * ESP8266 uses linker scripts that define FS_START, FS_END, FS_PAGE, FS_BLOCK
 * The values depend on the flash size configuration and framework.
 * 
 * Common configurations (from various linker scripts):
 * - 4MB (4096KB): Multiple variants exist
 *   - Standard: FS at 0x300000, size 1MB
 *   - FS 2MB: FS at 0x200000, size ~2MB (0x1FA000)
 * - 2MB (2048KB): FS at 0x1FB000, size ~20KB  
 * - 1MB (1024KB): FS at 0xDB000, size ~148KB
 * 
 * @param flashSizeMB - Flash size in megabytes
 * @returns Array of possible filesystem layouts (most common first)
 */
export function getESP8266FilesystemLayout(
  flashSizeMB: number,
): ESP8266FilesystemLayout[] {
  // Based on common ESP8266 linker script configurations
  // These match the eagle.flash.*.ld files in ESP8266 Arduino/framework
  
  if (flashSizeMB >= 4) {
    // 4MB flash: Multiple possible configurations
    return [
      // Most common: 2MB filesystem (like in your case)
      {
        start: 0x200000,
        end: 0x3fa000,
        size: 0x1fa000, // ~2MB
        page: 256,
        block: 8192,
      },
      // Alternative: 1MB filesystem
      {
        start: 0x300000,
        end: 0x400000,
        size: 0x100000, // 1MB
        page: 256,
        block: 8192,
      },
    ];
  } else if (flashSizeMB >= 2) {
    // 2MB flash: ~20KB filesystem
    return [
      {
        start: 0x1fb000,
        end: 0x200000,
        size: 0x5000, // ~20KB
        page: 256,
        block: 8192,
      },
    ];
  } else if (flashSizeMB >= 1) {
    // 1MB flash: ~148KB filesystem
    return [
      {
        start: 0xdb000,
        end: 0x100000,
        size: 0x25000, // ~148KB
        page: 256,
        block: 8192,
      },
    ];
  }
  
  return [];
}

/**
 * Filesystem types based on partition subtype
 */
export enum FilesystemType {
  UNKNOWN = "unknown",
  LITTLEFS = "littlefs",
  FATFS = "fatfs",
  SPIFFS = "spiffs",
}

/**
 * Detect filesystem type from partition information
 * Note: This only provides a hint. LittleFS is often stored in SPIFFS partitions (0x82).
 * Use detectFilesystemFromImage() for accurate detection.
 */
export function detectFilesystemType(partition: Partition): FilesystemType {
  if (partition.type !== 0x01) {
    return FilesystemType.UNKNOWN;
  }

  switch (partition.subtype) {
    case 0x81:
      return FilesystemType.FATFS;
    case 0x82:
      return FilesystemType.UNKNOWN;
    default:
      return FilesystemType.UNKNOWN;
  }
}

/**
 * Detect filesystem type from image data
 * Properly validates LittleFS superblock structure at correct offsets
 * 
 * @param imageData - Binary filesystem image data
 * @param chipName - Optional chip name for ESP8266-specific detection (e.g. "ESP8266")
 */
export function detectFilesystemFromImage(
  imageData: Uint8Array,
  chipName?: string,
): FilesystemType {
  if (imageData.length < 512) {
    return FilesystemType.UNKNOWN;
  }

  // Check for LittleFS superblock at proper offsets
  // LittleFS superblock structure:
  // - Offset 0-3: version (4 bytes, little-endian)
  // - Offset 4-7: CRC/flags (4 bytes)
  // - Offset 8-15: "littlefs" magic string (8 bytes ASCII)
  // - Offset 16+: additional metadata
  // The superblock is at block 0 and mirrored at block 1
  // Block size is determined by the distance between mirrored superblocks

  // Use chip-specific block sizes
  const isESP8266 = chipName?.toUpperCase().includes("ESP8266");
  const blockSizes = isESP8266
    ? ESP8266_LITTLEFS_BLOCK_SIZE_CANDIDATES
    : LITTLEFS_BLOCK_SIZE_CANDIDATES;
  
  for (const blockSize of blockSizes) {
    // Check first two blocks (superblock is mirrored)
    for (let blockIndex = 0; blockIndex < 2; blockIndex++) {
      const superblockOffset = blockIndex * blockSize;
      
      if (superblockOffset + 20 > imageData.length) {
        continue;
      }
      
      // Check for "littlefs" magic at offset 8 of superblock
      const magicOffset = superblockOffset + 8;
      if (magicOffset + 8 <= imageData.length) {
        const magicStr = String.fromCharCode(
          imageData[magicOffset],
          imageData[magicOffset + 1],
          imageData[magicOffset + 2],
          imageData[magicOffset + 3],
          imageData[magicOffset + 4],
          imageData[magicOffset + 5],
          imageData[magicOffset + 6],
          imageData[magicOffset + 7],
        );
        
        if (magicStr === "littlefs") {
          // Found valid LittleFS superblock with magic string
          // Validate version field to avoid false positives
          const version =
            imageData[superblockOffset] |
            (imageData[superblockOffset + 1] << 8) |
            (imageData[superblockOffset + 2] << 16) |
            (imageData[superblockOffset + 3] << 24);
          
          // Version must be non-zero and not erased flash (0xFFFFFFFF)
          // Use unsigned comparison
          if (version !== 0 && (version >>> 0) !== 0xFFFFFFFF) {
            return FilesystemType.LITTLEFS;
          }
        }
      }
    }
  }

  // Check for FAT filesystem signatures
  if (imageData.length >= 512) {
    const bootSig = imageData[510] | (imageData[511] << 8);
    if (bootSig === 0xaa55) {
      const fat16Sig =
        imageData.length >= 62
          ? String.fromCharCode(
              imageData[54],
              imageData[55],
              imageData[56],
              imageData[57],
              imageData[58],
            )
          : "";
      const fat32Sig =
        imageData.length >= 90
          ? String.fromCharCode(
              imageData[82],
              imageData[83],
              imageData[84],
              imageData[85],
              imageData[86],
            )
          : "";

      if (fat16Sig.startsWith("FAT") || fat32Sig.startsWith("FAT")) {
        return FilesystemType.FATFS;
      }
    }
  }

  // Check for SPIFFS magic (0x20140529)
  if (imageData.length >= 4) {
    const spiffsMagic =
      imageData[0] |
      (imageData[1] << 8) |
      (imageData[2] << 16) |
      (imageData[3] << 24);
    if (spiffsMagic === 0x20140529) {
      return FilesystemType.SPIFFS;
    }
  }

  return FilesystemType.UNKNOWN;
}

/**
 * Get appropriate block size for filesystem type and chip
 */
export function getDefaultBlockSize(
  fsType: FilesystemType,
  chipName?: string,
): number {
  const isESP8266 = chipName?.toUpperCase().includes("ESP8266");

  switch (fsType) {
    case FilesystemType.FATFS:
      return FATFS_DEFAULT_BLOCK_SIZE;
    case FilesystemType.LITTLEFS:
      return isESP8266
        ? ESP8266_LITTLEFS_BLOCK_SIZE
        : LITTLEFS_DEFAULT_BLOCK_SIZE;
    default:
      return isESP8266 ? ESP8266_LITTLEFS_BLOCK_SIZE : 4096;
  }
}

/**
 * Get block size candidates for filesystem type and chip
 */
export function getBlockSizeCandidates(
  fsType: FilesystemType,
  chipName?: string,
): number[] {
  const isESP8266 = chipName?.toUpperCase().includes("ESP8266");

  switch (fsType) {
    case FilesystemType.FATFS:
      return FATFS_BLOCK_SIZE_CANDIDATES;
    case FilesystemType.LITTLEFS:
      return isESP8266
        ? ESP8266_LITTLEFS_BLOCK_SIZE_CANDIDATES
        : LITTLEFS_BLOCK_SIZE_CANDIDATES;
    default:
      return isESP8266
        ? ESP8266_LITTLEFS_BLOCK_SIZE_CANDIDATES
        : [4096, 2048, 1024, 512];
  }
}
