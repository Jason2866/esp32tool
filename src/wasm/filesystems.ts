import type { Partition } from "../partition";

export const LITTLEFS_DEFAULT_BLOCK_SIZE = 4096;
export const LITTLEFS_BLOCK_SIZE_CANDIDATES = [4096, 2048, 1024, 512];
export const FATFS_DEFAULT_BLOCK_SIZE = 4096;
export const FATFS_BLOCK_SIZE_CANDIDATES = [4096, 2048, 1024, 512];

// ESP8266-specific parameters
export const ESP8266_LITTLEFS_BLOCK_SIZE = 8192;
export const ESP8266_LITTLEFS_BLOCK_SIZE_CANDIDATES = [8192, 4096];
export const ESP8266_LITTLEFS_PAGE_SIZE = 256;
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
 * Check if data contains SPIFFS filesystem using pattern detection
 * @param data - Data to check
 * @returns true if SPIFFS patterns detected
 */
function detectSPIFFSPatterns(data: Uint8Array): boolean {
  if (data.length < 4096) {
    return false;
  }
  
  let spiffsScore = 0;
  const pageSize = ESP8266_SPIFFS_PAGE_SIZE;
  const maxPages = Math.min(32, Math.floor(data.length / pageSize));
  
  for (let pageNum = 0; pageNum < maxPages; pageNum++) {
    const pageOffset = pageNum * pageSize;
    
    if (pageOffset + pageSize > data.length) break;
    
    const page = data.slice(pageOffset, pageOffset + pageSize);
    const objId = page[0] | (page[1] << 8);
    
    // Look for SPIFFS filename pattern: 0x01 followed by '/' and printable chars
    for (let i = 0; i < page.length - 10; i++) {
      if (page[i] === 0x01 && page[i+1] === 0x2f) { // 0x01 followed by '/'
        let validChars = 0;
        for (let j = i + 1; j < Math.min(i + 20, page.length); j++) {
          if (page[j] >= 0x20 && page[j] < 0x7f) {
            validChars++;
          } else if (page[j] === 0x00) {
            break;
          }
        }
        if (validChars >= 4) { // At least "/xxx"
          spiffsScore += 5;
          break;
        }
      }
    }
    
    // Check for typical SPIFFS object ID patterns
    if ((objId & 0x8000) !== 0) {
      const idLow = objId & 0x7fff;
      if (idLow > 0 && idLow < 0x1000) {
        spiffsScore += 2;
      }
    }
  }
  
  return spiffsScore >= 10;
}

/**
 * Scan ESP8266 flash for filesystem by detecting filesystem signatures
 * Reads actual block_count from LittleFS superblock for accurate size detection
 * 
 * @param flashData - Flash data starting at scanOffset
 * @param scanOffset - The offset in flash where this data starts
 * @param flashSize - Total flash size in bytes
 * @returns Detected filesystem layout or null
 */
export function scanESP8266Filesystem(
  flashData: Uint8Array,
  scanOffset: number,
  flashSize: number,
): ESP8266FilesystemLayout | null {
  // Check for LittleFS signature
  // LittleFS superblock has "littlefs" magic at offset 8 within block 0
  const blockSizes = ESP8266_LITTLEFS_BLOCK_SIZE_CANDIDATES; // ESP8266 typically uses 8192
  
  for (const blockSize of blockSizes) {
    // Check block 0 and block 1 (mirrored superblock)
    for (let blockIndex = 0; blockIndex < 2; blockIndex++) {
      const superblockOffset = blockIndex * blockSize;
      const magicOffset = superblockOffset + 8;

      if (magicOffset + 8 > flashData.length) {
        continue;
      }

      const magicStr = String.fromCharCode(
        flashData[magicOffset],
        flashData[magicOffset + 1],
        flashData[magicOffset + 2],
        flashData[magicOffset + 3],
        flashData[magicOffset + 4],
        flashData[magicOffset + 5],
        flashData[magicOffset + 6],
        flashData[magicOffset + 7],
      );

      if (magicStr === "littlefs") {
        // Validate version (at offset 16 in superblock)
        const versionOffset = superblockOffset + 16;
        const version =
          flashData[versionOffset] |
          (flashData[versionOffset + 1] << 8) |
          (flashData[versionOffset + 2] << 16) |
          (flashData[versionOffset + 3] << 24);

        if (version !== 0 && (version >>> 0) !== 0xffffffff) {
          // Found valid LittleFS!
          // Try to read block_count from superblock (offset 24, 4 bytes little-endian)
          const blockCountOffset = superblockOffset + 24;
          if (blockCountOffset + 4 <= flashData.length) {
            const blockCount =
              flashData[blockCountOffset] |
              (flashData[blockCountOffset + 1] << 8) |
              (flashData[blockCountOffset + 2] << 16) |
              (flashData[blockCountOffset + 3] << 24);
            
            // Validate block_count (should be reasonable: > 0 and < 100000)
            if (blockCount > 0 && blockCount < 100000) {
              const detectedSize = blockCount * blockSize;
              // Verify size is reasonable (not larger than remaining flash)
              if (detectedSize > 0 && scanOffset + detectedSize <= flashSize) {
                return {
                  start: scanOffset,
                  end: scanOffset + detectedSize,
                  size: detectedSize,
                  page: ESP8266_LITTLEFS_PAGE_SIZE,
                  block: blockSize,
                };
              }
            }
          }
          
          // Fallback to known layout patterns if block_count read failed
          return getLayoutForDetectedFilesystem(scanOffset, flashSize, blockSize);
        }
      }
    }
  }

  // Check for SPIFFS filesystem using pattern detection
  if (detectSPIFFSPatterns(flashData)) {
    // SPIFFS does not store size in the image itself
    // Size must come from linker script or partition table
    return getLayoutForDetectedFilesystem(scanOffset, flashSize, ESP8266_SPIFFS_BLOCK_SIZE);
  }
  
  // Also check for SPIFFS magic 0x20140529 (some implementations have it)
  if (flashData.length >= 4) {
    const spiffsMagic =
      flashData[0] |
      (flashData[1] << 8) |
      (flashData[2] << 16) |
      (flashData[3] << 24);

    if (spiffsMagic === 0x20140529) {
      // Found SPIFFS magic!
      // Additional validation: Check if header looks valid
      let validHeader = true;
      
      // Check if next bytes are not all 0xFF
      if (flashData.length >= 16) {
        let allFF = true;
        for (let i = 4; i < 16; i++) {
          if (flashData[i] !== 0xff) {
            allFF = false;
            break;
          }
        }
        if (allFF) {
          validHeader = false;
        }
      }
      
      if (validHeader) {
        return getLayoutForDetectedFilesystem(scanOffset, flashSize, ESP8266_SPIFFS_BLOCK_SIZE);
      }
    }
  }

  // Check for FAT filesystem
  // FAT can start at offset 0 or 0x1000 (4096 bytes) in ESP8266
  const fatOffsets = [0, 0x1000];
  
  for (const fatOffset of fatOffsets) {
    if (flashData.length < fatOffset + 512) {
      continue;
    }
    
    const bootSig = flashData[fatOffset + 510] | (flashData[fatOffset + 511] << 8);
    if (bootSig === 0xaa55) {
      // Read bytes per sector
      const bytesPerSector = flashData[fatOffset + 0x0b] | (flashData[fatOffset + 0x0c] << 8);
      
      // Validate bytes per sector (must be 512, 1024, 2048, or 4096)
      if (![512, 1024, 2048, 4096].includes(bytesPerSector)) {
        continue;
      }
      
      // Read total sectors (try 16-bit first, then 32-bit)
      let totalSectors = flashData[fatOffset + 0x13] | (flashData[fatOffset + 0x14] << 8);
      if (totalSectors === 0) {
        // Use 32-bit total sectors
        totalSectors =
          flashData[fatOffset + 0x20] |
          (flashData[fatOffset + 0x21] << 8) |
          (flashData[fatOffset + 0x22] << 16) |
          (flashData[fatOffset + 0x23] << 24);
      }
      
      // Validate values
      if (bytesPerSector > 0 && totalSectors > 0 && totalSectors < 100000000) {
        const detectedSize = totalSectors * bytesPerSector;
        
        // Verify size is reasonable (not larger than remaining flash)
        // Account for the FAT offset in the actual flash position
        const actualStart = scanOffset + fatOffset;
        if (detectedSize > 0 && actualStart + detectedSize <= flashSize) {
          return {
            start: actualStart,
            end: actualStart + detectedSize,
            size: detectedSize,
            page: bytesPerSector,
            block: bytesPerSector, // FAT uses sector size as block size
          };
        }
      }
    }
  }

  return null;
}

/**
 * Get filesystem layout based on detected offset and flash size
 * Uses known ESP8266 linker script patterns from Arduino/PlatformIO
 */
function getLayoutForDetectedFilesystem(
  offset: number,
  flashSize: number,
  blockSize: number,
): ESP8266FilesystemLayout {
  const flashSizeMB = flashSize / (1024 * 1024);
  
  // 16MB Flash layouts
  if (flashSizeMB >= 16) {
    if (offset === 0x100000) {
      return { start: 0x100000, end: 0xffa000, size: 0xefa000, page: 256, block: blockSize }; // 15MB
    } else if (offset === 0x200000) {
      return { start: 0x200000, end: 0xffa000, size: 0xdfa000, page: 256, block: blockSize }; // 14MB
    }
  }
  
  // 8MB Flash layouts
  if (flashSizeMB >= 8) {
    if (offset === 0x100000) {
      return { start: 0x100000, end: 0x7fa000, size: 0x6fa000, page: 256, block: blockSize }; // 7MB
    } else if (offset === 0x200000) {
      return { start: 0x200000, end: 0x7fa000, size: 0x5fa000, page: 256, block: blockSize }; // 6MB
    }
  }
  
  // 4MB Flash layouts
  if (flashSizeMB >= 4) {
    if (offset === 0x100000) {
      return { start: 0x100000, end: 0x3fa000, size: 0x2fa000, page: 256, block: blockSize }; // 3MB
    } else if (offset === 0x200000) {
      return { start: 0x200000, end: 0x3fa000, size: 0x1fa000, page: 256, block: blockSize }; // 2MB
    } else if (offset === 0x300000) {
      return { start: 0x300000, end: 0x3fa000, size: 0x0fa000, page: 256, block: blockSize }; // 1MB
    }
  }
  
  // 2MB Flash layouts
  if (flashSizeMB >= 2) {
    if (offset === 0x100000) {
      return { start: 0x100000, end: 0x1fa000, size: 0x0fa000, page: 256, block: blockSize }; // 1MB
    } else if (offset === 0x180000) {
      return { start: 0x180000, end: 0x1fa000, size: 0x07a000, page: 256, block: blockSize }; // 512KB
    } else if (offset === 0x1c0000) {
      return { start: 0x1c0000, end: 0x1fb000, size: 0x03b000, page: 256, block: blockSize }; // 256KB
    } else if (offset === 0x1e0000) {
      return { start: 0x1e0000, end: 0x1fb000, size: 0x01b000, page: 256, block: blockSize }; // 128KB
    } else if (offset === 0x1f0000) {
      return { start: 0x1f0000, end: 0x1fb000, size: 0x00b000, page: 256, block: blockSize }; // 64KB
    }
  }
  
  // 1MB Flash layouts
  if (flashSizeMB >= 1) {
    if (offset === 0x07b000) {
      return { start: 0x07b000, end: 0x0fb000, size: 0x080000, page: 256, block: blockSize }; // 512KB
    } else if (offset === 0x0bb000) {
      return { start: 0x0bb000, end: 0x0fb000, size: 0x040000, page: 256, block: blockSize }; // 256KB
    } else if (offset === 0x0cb000) {
      return { start: 0x0cb000, end: 0x0fb000, size: 0x030000, page: 256, block: blockSize }; // 192KB
    } else if (offset === 0x0d3000) {
      return { start: 0x0d3000, end: 0x0fb000, size: 0x028000, page: 256, block: blockSize }; // 160KB
    } else if (offset === 0x0d7000) {
      return { start: 0x0d7000, end: 0x0fb000, size: 0x024000, page: 256, block: blockSize }; // 144KB
    } else if (offset === 0x0db000) {
      return { start: 0x0db000, end: 0x0fb000, size: 0x020000, page: 256, block: blockSize }; // 128KB
    } else if (offset === 0x0eb000) {
      return { start: 0x0eb000, end: 0x0fb000, size: 0x010000, page: 256, block: blockSize }; // 64KB
    }
  }
  
  // 512KB Flash layouts
  if (flashSizeMB >= 0.5) {
    if (offset === 0x05b000) {
      return { start: 0x05b000, end: 0x07b000, size: 0x020000, page: 256, block: blockSize }; // 128KB
    } else if (offset === 0x06b000) {
      return { start: 0x06b000, end: 0x07b000, size: 0x010000, page: 256, block: blockSize }; // 64KB
    } else if (offset === 0x073000) {
      return { start: 0x073000, end: 0x07b000, size: 0x008000, page: 256, block: blockSize }; // 32KB
    }
  }
  
  // Fallback: use remaining flash space
  const size = flashSize - offset;
  return {
    start: offset,
    end: flashSize,
    size: size,
    page: 256,
    block: blockSize,
  };
}

/**
 * Get common ESP8266 filesystem layouts as fallback
 * Used when we can't scan the actual flash
 * 
 * @param flashSizeMB - Flash size in megabytes
 * @returns Array of possible filesystem layouts (most common first)
 */
export function getESP8266FilesystemLayout(
  flashSizeMB: number,
): ESP8266FilesystemLayout[] {
  // Based on common ESP8266 linker script configurations
  
  if (flashSizeMB >= 16) {
    // 16MB flash
    return [
      { start: 0x100000, end: 0xffa000, size: 0xefa000, page: 256, block: 8192 }, // 15MB
      { start: 0x200000, end: 0xffa000, size: 0xdfa000, page: 256, block: 8192 }, // 14MB
    ];
  } else if (flashSizeMB >= 8) {
    // 8MB flash
    return [
      { start: 0x100000, end: 0x7fa000, size: 0x6fa000, page: 256, block: 8192 }, // 7MB
      { start: 0x200000, end: 0x7fa000, size: 0x5fa000, page: 256, block: 8192 }, // 6MB
    ];
  } else if (flashSizeMB >= 4) {
    // 4MB flash: Multiple possible configurations
    return [
      { start: 0x200000, end: 0x3fa000, size: 0x1fa000, page: 256, block: 8192 }, // 2MB (most common)
      { start: 0x100000, end: 0x3fa000, size: 0x2fa000, page: 256, block: 8192 }, // 3MB
      { start: 0x300000, end: 0x3fa000, size: 0x0fa000, page: 256, block: 8192 }, // 1MB
    ];
  } else if (flashSizeMB >= 2) {
    // 2MB flash
    return [
      { start: 0x100000, end: 0x1fa000, size: 0x0fa000, page: 256, block: 8192 }, // 1MB
      { start: 0x180000, end: 0x1fa000, size: 0x07a000, page: 256, block: 8192 }, // 512KB
      { start: 0x1c0000, end: 0x1fb000, size: 0x03b000, page: 256, block: 8192 }, // 256KB
      { start: 0x1e0000, end: 0x1fb000, size: 0x01b000, page: 256, block: 8192 }, // 128KB
      { start: 0x1f0000, end: 0x1fb000, size: 0x00b000, page: 256, block: 8192 }, // 64KB
    ];
  } else if (flashSizeMB >= 1) {
    // 1MB flash
    return [
      { start: 0x0db000, end: 0x0fb000, size: 0x020000, page: 256, block: 8192 }, // 128KB (most common)
      { start: 0x07b000, end: 0x0fb000, size: 0x080000, page: 256, block: 8192 }, // 512KB
      { start: 0x0bb000, end: 0x0fb000, size: 0x040000, page: 256, block: 8192 }, // 256KB
      { start: 0x0cb000, end: 0x0fb000, size: 0x030000, page: 256, block: 8192 }, // 192KB
      { start: 0x0d3000, end: 0x0fb000, size: 0x028000, page: 256, block: 8192 }, // 160KB
      { start: 0x0d7000, end: 0x0fb000, size: 0x024000, page: 256, block: 8192 }, // 144KB
      { start: 0x0eb000, end: 0x0fb000, size: 0x010000, page: 256, block: 8192 }, // 64KB
    ];
  } else if (flashSizeMB >= 0.5) {
    // 512KB flash
    return [
      { start: 0x05b000, end: 0x07b000, size: 0x020000, page: 256, block: 8192 }, // 128KB
      { start: 0x06b000, end: 0x07b000, size: 0x010000, page: 256, block: 8192 }, // 64KB
      { start: 0x073000, end: 0x07b000, size: 0x008000, page: 256, block: 8192 }, // 32KB
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
          // Validate version field to avoid false positives (at offset 16)
          const versionOffset = superblockOffset + 16;
          const version =
            imageData[versionOffset] |
            (imageData[versionOffset + 1] << 8) |
            (imageData[versionOffset + 2] << 16) |
            (imageData[versionOffset + 3] << 24);
          
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
  // FAT can start at offset 0 or 0x1000 (4096 bytes) in ESP8266
  const fatOffsets = [0, 0x1000];
  
  for (const fatOffset of fatOffsets) {
    if (imageData.length < fatOffset + 512) {
      continue;
    }
    
    const bootSig = imageData[fatOffset + 510] | (imageData[fatOffset + 511] << 8);
    if (bootSig === 0xaa55) {
      const fat16Sig =
        imageData.length >= fatOffset + 62
          ? String.fromCharCode(
              imageData[fatOffset + 54],
              imageData[fatOffset + 55],
              imageData[fatOffset + 56],
              imageData[fatOffset + 57],
              imageData[fatOffset + 58],
            )
          : "";
      const fat32Sig =
        imageData.length >= fatOffset + 90
          ? String.fromCharCode(
              imageData[fatOffset + 82],
              imageData[fatOffset + 83],
              imageData[fatOffset + 84],
              imageData[fatOffset + 85],
              imageData[fatOffset + 86],
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

  // Check for SPIFFS filesystem using pattern detection
  if (detectSPIFFSPatterns(imageData)) {
    return FilesystemType.SPIFFS;
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
