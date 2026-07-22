(function exposeBioAssayCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BioAssayCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  function finitePositive(value) {
    return Number.isFinite(Number(value)) && Number(value) > 0;
  }

  function median(values) {
    const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!sorted.length) return NaN;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function roiConsistency(rois, tolerance = 0.1) {
    const dimensions = (rois || []).map(roi => ({
      width: Number(roi.width),
      height: Number(roi.height),
    })).filter(item => finitePositive(item.width) && finitePositive(item.height));
    if (!dimensions.length) return { consistent: true, medianWidth: NaN, medianHeight: NaN, outlierIndexes: [] };
    const medianWidth = median(dimensions.map(item => item.width));
    const medianHeight = median(dimensions.map(item => item.height));
    const limit = Math.max(0, Number(tolerance) || 0);
    const outlierIndexes = [];
    dimensions.forEach((item, index) => {
      const widthDeviation = Math.abs(item.width - medianWidth) / medianWidth;
      const heightDeviation = Math.abs(item.height - medianHeight) / medianHeight;
      if (widthDeviation > limit || heightDeviation > limit) outlierIndexes.push(index);
    });
    return {
      consistent: outlierIndexes.length === 0,
      medianWidth,
      medianHeight,
      outlierIndexes,
    };
  }

  function suggestedLoadVolume(currentVolume, baselineReferenceSignal, currentReferenceSignal) {
    if (![currentVolume, baselineReferenceSignal, currentReferenceSignal].every(finitePositive)) return NaN;
    return Number(currentVolume) * Number(baselineReferenceSignal) / Number(currentReferenceSignal);
  }

  function editLaneAnnotations(names, values, action, index) {
    const nextNames = Array.from(names || [], value => String(value));
    const nextValues = Array.from(values || [], value => String(value));
    const targetIndex = Math.max(0, Math.min(Math.round(Number(index) || 0), action === 'insert' ? nextNames.length : Math.max(0, nextNames.length - 1)));
    if (action === 'insert') {
      nextNames.splice(targetIndex, 0, `泳道 ${targetIndex + 1}`);
      if (nextValues.length) nextValues.splice(Math.min(targetIndex, nextValues.length), 0, '—');
    } else if (action === 'delete') {
      if (targetIndex < nextNames.length) nextNames.splice(targetIndex, 1);
      if (targetIndex < nextValues.length) nextValues.splice(targetIndex, 1);
    }
    nextNames.forEach((name, laneIndex) => {
      if (/^泳道\s*\d+$/i.test(name)) nextNames[laneIndex] = `泳道 ${laneIndex + 1}`;
    });
    return { names: nextNames, values: nextValues };
  }

  function signalBoundaryQuality(profile, blankMarginLimit = 0.35) {
    const values = Array.from(profile || [], value => Number(value)).filter(Number.isFinite);
    if (values.length < 3) {
      return { severity: 'warn', text: '边界数据不足', clippedLeft: false, clippedRight: false, excessiveLeftMargin: false, excessiveRightMargin: false };
    }
    const sorted = values.slice().sort((a, b) => a - b);
    const baselineCount = Math.max(1, Math.ceil(sorted.length * 0.3));
    const baseline = median(sorted.slice(0, baselineCount));
    const peak = Math.max(...values);
    const range = Math.max(0, peak - baseline);
    const threshold = baseline + range * 0.18;
    const firstSignal = values.findIndex(value => value >= threshold);
    const reversedSignal = [...values].reverse().findIndex(value => value >= threshold);
    const lastSignal = reversedSignal < 0 ? -1 : values.length - 1 - reversedSignal;
    const edgeThreshold = baseline + range * 0.28;
    const clippedLeft = range > 0 && firstSignal <= 1 && values[0] >= edgeThreshold;
    const clippedRight = range > 0 && lastSignal >= values.length - 2 && values[values.length - 1] >= edgeThreshold;
    const leftBlankFraction = firstSignal < 0 ? 1 : firstSignal / values.length;
    const rightBlankFraction = lastSignal < 0 ? 1 : (values.length - 1 - lastSignal) / values.length;
    const excessiveLeftMargin = !clippedLeft && leftBlankFraction > blankMarginLimit;
    const excessiveRightMargin = !clippedRight && rightBlankFraction > blankMarginLimit;
    const issues = [];
    if (clippedLeft) issues.push('左侧疑似截断');
    if (clippedRight) issues.push('右侧疑似截断');
    if (excessiveLeftMargin) issues.push('左侧留白偏多');
    if (excessiveRightMargin) issues.push('右侧留白偏多');
    return {
      severity: issues.length ? 'warn' : 'good',
      text: issues.length ? issues.join('；') : '边界通过',
      clippedLeft,
      clippedRight,
      excessiveLeftMargin,
      excessiveRightMargin,
      leftBlankFraction,
      rightBlankFraction,
      baseline,
      peak,
    };
  }

  function refineSignalBounds(profile, options = {}) {
    const values = Array.from(profile || [], value => Number(value));
    const length = values.length;
    if (length < 3 || values.some(value => !Number.isFinite(value))) {
      return {
        left: 0,
        right: Math.max(0, length - 1),
        signalLeft: 0,
        signalRight: Math.max(0, length - 1),
        center: Math.max(0, (length - 1) / 2),
        confidence: 0,
        usable: false,
      };
    }
    const smoothRadius = Math.max(0, Math.min(5, Math.round(Number(options.smoothRadius) || length * 0.012)));
    const prefix = [0];
    values.forEach(value => prefix.push(prefix[prefix.length - 1] + value));
    const smoothed = values.map((_, index) => {
      const start = Math.max(0, index - smoothRadius);
      const end = Math.min(length - 1, index + smoothRadius);
      return (prefix[end + 1] - prefix[start]) / (end - start + 1);
    });
    const sorted = smoothed.slice().sort((a, b) => a - b);
    // Wide WB bands can occupy most of a lane window. Keeping the baseline
    // sample deliberately small prevents the band shoulders from being
    // mistaken for noise, which otherwise clips one side of broad bands.
    const baselineCount = Math.max(2, Math.ceil(length * 0.22));
    const baselineValues = sorted.slice(0, baselineCount);
    const baseline = median(baselineValues);
    const deviations = baselineValues.map(value => Math.abs(value - baseline));
    const noise = Math.max(
      1e-9,
      median(deviations) * 1.4826,
      (sorted[Math.min(length - 1, Math.floor(length * 0.3))] - sorted[Math.floor(length * 0.08)]) * 0.42,
    );
    let peakIndex = 0;
    for (let index = 1; index < length; index += 1) if (smoothed[index] > smoothed[peakIndex]) peakIndex = index;
    const peak = smoothed[peakIndex];
    const amplitude = Math.max(0, peak - baseline);
    if (!(amplitude > noise * 1.15)) {
      return {
        left: 0,
        right: length - 1,
        signalLeft: peakIndex,
        signalRight: peakIndex,
        center: peakIndex,
        baseline,
        peak,
        noise,
        threshold: baseline + noise,
        confidence: 0,
        usable: false,
      };
    }
    const thresholdFraction = Math.max(0.025, Math.min(0.3, Number(options.thresholdFraction) || 0.07));
    const noiseMultiplier = Math.max(0.6, Math.min(3, Number(options.noiseMultiplier) || 1.45));
    const threshold = baseline + Math.max(amplitude * thresholdFraction, noise * noiseMultiplier);
    const maximumGap = Math.max(1, Math.min(Math.floor(length * 0.14), Math.round(Number(options.maximumGap) || length * 0.045)));
    let signalLeft = peakIndex;
    let signalRight = peakIndex;
    let gap = 0;
    for (let index = peakIndex - 1; index >= 0; index -= 1) {
      if (smoothed[index] >= threshold) {
        signalLeft = index;
        gap = 0;
      } else if (++gap > maximumGap) break;
    }
    gap = 0;
    for (let index = peakIndex + 1; index < length; index += 1) {
      if (smoothed[index] >= threshold) {
        signalRight = index;
        gap = 0;
      } else if (++gap > maximumGap) break;
    }
    const signalWidth = signalRight - signalLeft + 1;
    const paddingFraction = Math.max(0, Math.min(0.5, Number(options.paddingFraction) || 0.16));
    const padding = Math.max(1, Math.round(Number(options.minimumPadding) || 1), Math.round(signalWidth * paddingFraction));
    const left = Math.max(0, signalLeft - padding);
    const right = Math.min(length - 1, signalRight + padding);
    const weights = smoothed.slice(signalLeft, signalRight + 1).map(value => Math.max(0, value - baseline));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    const center = totalWeight > 0
      ? signalLeft + weights.reduce((sum, value, index) => sum + value * index, 0) / totalWeight
      : (signalLeft + signalRight) / 2;
    const signalToNoise = amplitude / Math.max(noise, 1e-9);
    const confidence = Math.max(0, Math.min(1, (1 - Math.exp(-signalToNoise / 5)) * Math.min(1, signalWidth / Math.max(3, length * 0.18))));
    return {
      left,
      right,
      signalLeft,
      signalRight,
      center,
      baseline,
      peak,
      noise,
      threshold,
      confidence,
      usable: true,
      clippedLeft: signalLeft === 0 && smoothed[0] >= threshold,
      clippedRight: signalRight === length - 1 && smoothed[length - 1] >= threshold,
    };
  }

  function separateNeighborRois(rois, minimumWidth = 4) {
    const selected = (rois || []).map(roi => ({ ...roi })).sort((a, b) => (a.x + a.width / 2) - (b.x + b.width / 2));
    selected.forEach((candidate, index) => {
      const previous = selected[index - 1];
      if (!previous || (previous.laneIndex !== undefined && previous.laneIndex === candidate.laneIndex) || previous.x + previous.width <= candidate.x) return;
      const previousCenter = previous.x + previous.width / 2;
      const candidateCenter = candidate.x + candidate.width / 2;
      const divider = Math.round((previousCenter + candidateCenter) / 2);
      const candidateRight = candidate.x + candidate.width;
      previous.width = Math.max(minimumWidth, divider - previous.x - 1);
      candidate.x = Math.min(candidateRight - minimumWidth, divider + 1);
      candidate.width = Math.max(minimumWidth, candidateRight - candidate.x);
    });
    return selected;
  }

  function dpiToPixelsPerMeter(dpi) {
    if (!finitePositive(dpi)) return 0;
    return Math.round(Number(dpi) / 0.0254);
  }

  function pixelsForPhysicalWidth(millimeters, dpi) {
    if (!finitePositive(millimeters) || !finitePositive(dpi)) return 0;
    return Math.round(Number(millimeters) / 25.4 * Number(dpi));
  }

  function readUint32(bytes, offset) {
    return (((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
  }

  function writeUint32(bytes, offset, value) {
    bytes[offset] = (value >>> 24) & 255;
    bytes[offset + 1] = (value >>> 16) & 255;
    bytes[offset + 2] = (value >>> 8) & 255;
    bytes[offset + 3] = value & 255;
  }

  function ascii(bytes, offset, length) {
    let result = '';
    for (let index = 0; index < length; index += 1) result += String.fromCharCode(bytes[offset + index]);
    return result;
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let index = 0; index < bytes.length; index += 1) {
      crc ^= bytes[index];
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function concatBytes(chunks) {
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    chunks.forEach(chunk => {
      output.set(chunk, offset);
      offset += chunk.length;
    });
    return output;
  }

  function pngChunk(type, data) {
    const typeBytes = new Uint8Array([...type].map(character => character.charCodeAt(0)));
    const chunk = new Uint8Array(12 + data.length);
    writeUint32(chunk, 0, data.length);
    chunk.set(typeBytes, 4);
    chunk.set(data, 8);
    writeUint32(chunk, 8 + data.length, crc32(concatBytes([typeBytes, data])));
    return chunk;
  }

  function validatePng(bytes) {
    if (bytes.length < PNG_SIGNATURE.length || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
      throw new TypeError('Expected PNG bytes');
    }
  }

  function setPngDpi(input, dpi) {
    const bytes = input instanceof Uint8Array ? new Uint8Array(input) : new Uint8Array(input);
    validatePng(bytes);
    const pixelsPerMeter = dpiToPixelsPerMeter(dpi);
    if (!pixelsPerMeter) throw new RangeError('DPI must be greater than zero');
    const physicalData = new Uint8Array(9);
    writeUint32(physicalData, 0, pixelsPerMeter);
    writeUint32(physicalData, 4, pixelsPerMeter);
    physicalData[8] = 1;
    const physicalChunk = pngChunk('pHYs', physicalData);
    const outputChunks = [bytes.slice(0, 8)];
    let offset = 8;
    let inserted = false;
    while (offset + 12 <= bytes.length) {
      const length = readUint32(bytes, offset);
      const end = offset + 12 + length;
      if (end > bytes.length) throw new TypeError('Invalid PNG chunk length');
      const type = ascii(bytes, offset + 4, 4);
      if (type !== 'pHYs') outputChunks.push(bytes.slice(offset, end));
      if (type === 'IHDR' && !inserted) {
        outputChunks.push(physicalChunk);
        inserted = true;
      }
      offset = end;
      if (type === 'IEND') break;
    }
    if (!inserted) throw new TypeError('PNG has no IHDR chunk');
    return concatBytes(outputChunks);
  }

  function readPngDpi(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    validatePng(bytes);
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = readUint32(bytes, offset);
      const end = offset + 12 + length;
      if (end > bytes.length) return NaN;
      const type = ascii(bytes, offset + 4, 4);
      if (type === 'pHYs' && length === 9 && bytes[offset + 16] === 1) {
        return Math.round(readUint32(bytes, offset + 8) * 0.0254);
      }
      offset = end;
    }
    return NaN;
  }

  return {
    dpiToPixelsPerMeter,
    editLaneAnnotations,
    pixelsForPhysicalWidth,
    readPngDpi,
    refineSignalBounds,
    roiConsistency,
    separateNeighborRois,
    setPngDpi,
    signalBoundaryQuality,
    suggestedLoadVolume,
  };
}));
