import type { Partition } from "../partition";

export const LITTLEFS_DEFAULT_BLOCK_SIZE = 4096;
export const LITTLEFS_BLOCK_SIZE_CANDIDATES = [4096, 2048, 1024, 512];
export const FATFS_DEFAULT_BLOCK_SIZE = 4096;
export const FATFS_BLOCK_SIZE_CANDIDATES = [4096, 2048, 1024, 512];

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
 */
export function detectFilesystemFromImage(
  imageData: Uint8Array,
): FilesystemType {
  if (imageData.length < 512) {
    return FilesystemType.UNKNOWN;
  }

  // Check for LittleFS superblock at proper offsets
  // LittleFS superblock structure:
  // - Offset 0-3: version (4 bytes, little-endian)
  // - Offset 4-7: block_size (4 bytes, little-endian)
  // - Offset 8-15: "littlefs" magic string (8 bytes ASCII)
  // - Offset 16-19: block_count (4 bytes, little-endian)
  // The superblock is at block 0 and mirrored at block 1
  
  const blockSizes = LITTLEFS_BLOCK_SIZE_CANDIDATES;
  
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
          // Additional validation: check version field
          const version =
            imageData[superblockOffset] |
            (imageData[superblockOffset + 1] << 8) |
            (imageData[superblockOffset + 2] << 16) |
            (imageData[superblockOffset + 3] << 24);
          
          // LittleFS version should be 0x00020000 (v2.0) or 0x00020001 (v2.1)
          // Check major version is 2
          if ((version >>> 16) === 0x0002) {
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
 * Get appropriate block size for filesystem type
 */
export function getDefaultBlockSize(fsType: FilesystemType): number {
  switch (fsType) {
    case FilesystemType.FATFS:
      return FATFS_DEFAULT_BLOCK_SIZE;
    case FilesystemType.LITTLEFS:
      return LITTLEFS_DEFAULT_BLOCK_SIZE;
    default:
      return 4096;
  }
}

/**
 * Get block size candidates for filesystem type
 */
export function getBlockSizeCandidates(fsType: FilesystemType): number[] {
  switch (fsType) {
    case FilesystemType.FATFS:
      return FATFS_BLOCK_SIZE_CANDIDATES;
    case FilesystemType.LITTLEFS:
      return LITTLEFS_BLOCK_SIZE_CANDIDATES;
    default:
      return [4096, 2048, 1024, 512];
  }
}
