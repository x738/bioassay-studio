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

  function numericReplicates(values) {
    return Array.from(values || []).map(value => {
      if (value === null || value === undefined || String(value).trim() === '') return NaN;
      return Number(String(value).replace(',', '.'));
    }).filter(Number.isFinite);
  }

  function replicateSummary(values) {
    const numbers = numericReplicates(values);
    if (!numbers.length) return { n: 0, mean: NaN, sd: NaN, cv: NaN };
    const average = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
    const variance = numbers.length > 1
      ? numbers.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (numbers.length - 1)
      : 0;
    const sd = Math.sqrt(Math.max(0, variance));
    return {
      n: numbers.length,
      mean: average,
      sd,
      cv: average === 0 ? (sd === 0 ? 0 : Infinity) : Math.abs(sd / average) * 100,
    };
  }

  function linearRegression(points, { forceOrigin = false } = {}) {
    const rows = Array.from(points || []).map(point => ({
      x: Number(point?.x),
      y: Number(point?.y),
    })).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (rows.length < 2) return { n: rows.length, slope: NaN, intercept: NaN, r2: NaN, predictions: [] };
    const meanX = rows.reduce((sum, point) => sum + point.x, 0) / rows.length;
    const meanY = rows.reduce((sum, point) => sum + point.y, 0) / rows.length;
    let slope;
    let intercept;
    if (forceOrigin) {
      const denominator = rows.reduce((sum, point) => sum + point.x ** 2, 0);
      slope = denominator ? rows.reduce((sum, point) => sum + point.x * point.y, 0) / denominator : NaN;
      intercept = 0;
    } else {
      const denominator = rows.reduce((sum, point) => sum + ((point.x - meanX) ** 2), 0);
      slope = denominator
        ? rows.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / denominator
        : NaN;
      intercept = Number.isFinite(slope) ? meanY - slope * meanX : NaN;
    }
    const predictions = rows.map(point => Number.isFinite(slope) ? slope * point.x + intercept : NaN);
    const sse = rows.reduce((sum, point, index) => sum + ((point.y - predictions[index]) ** 2), 0);
    const sst = rows.reduce((sum, point) => sum + ((point.y - meanY) ** 2), 0);
    const r2 = sst <= Number.EPSILON ? (sse <= Number.EPSILON ? 1 : 0) : 1 - (sse / sst);
    return { n: rows.length, slope, intercept, r2, predictions };
  }

  function standardDilutionPlan({
    targetConcentration,
    stockConcentration,
    finalVolume,
  } = {}) {
    const target = Number(targetConcentration);
    const stock = Number(stockConcentration);
    const volume = Number(finalVolume);
    if (![target, stock, volume].every(Number.isFinite) || target < 0 || stock <= 0 || volume <= 0) {
      return {
        valid: false,
        stockVolume: NaN,
        diluentVolume: NaN,
        reason: '浓度和体积必须为有效正数，目标浓度可为 0。',
      };
    }
    if (target > stock) {
      return {
        valid: false,
        stockVolume: NaN,
        diluentVolume: NaN,
        reason: '目标浓度高于标准储备液浓度，无法通过稀释获得。',
      };
    }
    const stockVolume = target * volume / stock;
    return {
      valid: true,
      stockVolume,
      diluentVolume: Math.max(0, volume - stockVolume),
      reason: '',
    };
  }

  function coomassieSampleResult({
    absorbances = [],
    blankAbsorbance = 0,
    slope,
    intercept = 0,
    dilution = 1,
    extractionVolume,
    sampleMass,
  } = {}) {
    const summary = replicateSummary(absorbances);
    const adjustedAbsorbance = summary.mean - Number(blankAbsorbance || 0);
    const numericSlope = Number(slope);
    const measuredConcentration = Number.isFinite(adjustedAbsorbance) && Number.isFinite(numericSlope) && numericSlope !== 0
      ? (adjustedAbsorbance - Number(intercept || 0)) / numericSlope
      : NaN;
    // A dilution factor of 0 has no physical meaning. Keep the core safe even
    // when it is called outside the UI, where the select already starts at 1×.
    const dilutionFactor = Math.max(1, Number(dilution) || 1);
    const originalConcentration = measuredConcentration * dilutionFactor;
    const volume = Number(extractionVolume);
    const mass = Number(sampleMass);
    const proteinContent = Number.isFinite(originalConcentration) && Number.isFinite(volume) && Number.isFinite(mass) && mass > 0
      ? originalConcentration * volume / mass
      : NaN;
    return {
      ...summary,
      adjustedAbsorbance,
      measuredConcentration,
      dilutionFactor,
      originalConcentration,
      proteinContent,
    };
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

  function filterBandGeometryOutliers(candidates, { sourceWidth = 0, sourceHeight = 0, expectedLaneCount = 0 } = {}) {
    const input = Array.from(candidates || []);
    // An explicit count is an experimental constraint and takes precedence.
    // Automatic mode stays conservative and only removes a candidate when it
    // is both far away from the robust band row and has independent evidence
    // of being an artefact (outer-edge position, weak score or abnormal size).
    if (Number(expectedLaneCount) > 0 || input.length < 5) return input;
    const groups = new Map();
    input.forEach(candidate => {
      const key = Number.isFinite(Number(candidate.bandIndex)) ? Number(candidate.bandIndex) : 0;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(candidate);
    });
    const rejected = new Set();
    groups.forEach(group => {
      if (group.length < 5) return;
      const points = group.map(candidate => ({
        candidate,
        x: Number(candidate.x) + Number(candidate.width) / 2,
        y: Number(candidate.y) + Number(candidate.height) / 2,
      })).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
      if (points.length < 5) return;
      const slopes = [];
      points.forEach((left, leftIndex) => points.slice(leftIndex + 1).forEach(right => {
        const deltaX = right.x - left.x;
        if (Math.abs(deltaX) > 2) slopes.push((right.y - left.y) / deltaX);
      }));
      const slope = median(slopes);
      if (!Number.isFinite(slope)) return;
      const intercept = median(points.map(point => point.y - slope * point.x));
      const residuals = points.map(point => Math.abs(point.y - (slope * point.x + intercept)));
      const residualMedian = median(residuals);
      const residualMad = median(residuals.map(value => Math.abs(value - residualMedian)));
      const medianHeight = median(points.map(point => Number(point.candidate.height)).filter(finitePositive));
      const medianWidth = median(points.map(point => Number(point.candidate.width)).filter(finitePositive));
      const medianScore = median(points.map(point => Number(point.candidate.score)).filter(Number.isFinite));
      const residualLimit = Math.max(
        4,
        Number(sourceHeight) * 0.008,
        Number.isFinite(medianHeight) ? medianHeight * 0.48 : 0,
        residualMedian + Math.max(3, (Number.isFinite(residualMad) ? residualMad : 0) * 4),
      );
      points.forEach((point, index) => {
        if (residuals[index] <= residualLimit) return;
        const candidate = point.candidate;
        const outerEdge = Number(sourceWidth) > 0 && (point.x < Number(sourceWidth) * 0.13 || point.x > Number(sourceWidth) * 0.87);
        const weakScore = Number.isFinite(medianScore) && Number.isFinite(Number(candidate.score))
          && Number(candidate.score) < medianScore * 0.72;
        const abnormalSize = (Number.isFinite(medianHeight) && Number(candidate.height) > medianHeight * 1.85)
          || (Number.isFinite(medianWidth) && Number(candidate.width) > medianWidth * 1.85);
        if (outerEdge || weakScore || abnormalSize) rejected.add(candidate);
      });
    });
    return input.filter(candidate => !rejected.has(candidate));
  }

  function suggestedLoadVolume(currentVolume, baselineReferenceSignal, currentReferenceSignal) {
    if (![currentVolume, baselineReferenceSignal, currentReferenceSignal].every(finitePositive)) return NaN;
    return Number(currentVolume) * Number(baselineReferenceSignal) / Number(currentReferenceSignal);
  }

  function classifySaturation(nearClippedFraction, hardClippedFraction, longestRunFraction) {
    const near = Math.max(0, Number(nearClippedFraction) || 0);
    const hard = Math.max(0, Number(hardClippedFraction) || 0);
    const run = Math.max(0, Number(longestRunFraction) || 0);
    if (near >= 0.12 || hard >= 0.04 || (hard >= 0.01 && run >= 0.08)) return 'bad';
    if (near >= 0.01 || hard >= 0.003) return 'warn';
    return 'good';
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

  function detectLineBands(profile, options = {}) {
    const values = Array.from(profile || [], value => Number(value));
    const length = values.length;
    if (length < 5 || values.some(value => !Number.isFinite(value))) {
      return { segments: [], baseline: [], residual: [], highThreshold: NaN, lowThreshold: NaN, noise: NaN };
    }
    const sensitivity = Math.max(1, Math.min(100, Number(options.sensitivity) || 65));
    const smoothRadius = Math.max(1, Math.min(9, Math.round(Number(options.smoothRadius) || length * 0.004)));
    const smooth = source => {
      const prefix = [0];
      source.forEach(value => prefix.push(prefix[prefix.length - 1] + value));
      return source.map((_, index) => {
        const start = Math.max(0, index - smoothRadius);
        const end = Math.min(length - 1, index + smoothRadius);
        return (prefix[end + 1] - prefix[start]) / (end - start + 1);
      });
    };
    const smoothed = smooth(values);
    // The hand-drawn strip is a lane profile, not a generic texture scan.
    // Use a deliberately broad background window so one wide physical band is
    // not converted into several local residual peaks.
    const baselineRadius = Math.max(9, Math.min(Math.floor(length / 3), Math.round(Number(options.baselineRadius) || length * 0.32)));
    const baseline = smoothed.map((_, index) => {
      const start = Math.max(0, index - baselineRadius);
      const end = Math.min(length - 1, index + baselineRadius);
      const window = smoothed.slice(start, end + 1).sort((a, b) => a - b);
      return window[Math.max(0, Math.min(window.length - 1, Math.floor(window.length * 0.22)))];
    });
    const residual = smooth(smoothed.map((value, index) => Math.max(0, value - baseline[index])));
    const sortedResidual = residual.slice().sort((a, b) => a - b);
    const quiet = sortedResidual.slice(0, Math.max(3, Math.floor(length * 0.55)));
    const quietMedian = median(quiet);
    const noise = Math.max(1e-9, median(quiet.map(value => Math.abs(value - quietMedian))) * 1.4826);
    const peak = sortedResidual[Math.max(0, Math.min(length - 1, Math.floor(length * 0.995)))];
    const highFraction = 0.052 - sensitivity * 0.00028;
    const lowFraction = 0.014 - sensitivity * 0.000055;
    const highThreshold = Math.max(noise * (2.45 - sensitivity * 0.009), peak * Math.max(0.018, highFraction));
    const lowThreshold = Math.max(noise * 0.72, peak * Math.max(0.006, lowFraction));
    const minimumWidth = Math.max(2, Math.round(Number(options.minimumWidth) || length * 0.004));
    const mergeGap = Math.max(2, Math.round(Number(options.mergeGap) || length * 0.012));
    const padding = Math.max(1, Math.round(Number(options.padding) || length * 0.0035));
    const seeds = [];
    let start = -1;
    residual.forEach((value, index) => {
      if (value >= highThreshold && start < 0) start = index;
      if ((value < highThreshold || index === length - 1) && start >= 0) {
        const end = value >= highThreshold && index === length - 1 ? index : index - 1;
        seeds.push({ start, end });
        start = -1;
      }
    });
    const expanded = seeds.map(seed => {
      let left = seed.start;
      let right = seed.end;
      while (left > 0 && residual[left - 1] >= lowThreshold) left -= 1;
      while (right < length - 1 && residual[right + 1] >= lowThreshold) right += 1;
      return { start: left, end: right };
    });
    const sortedSmoothed = smoothed.slice().sort((a, b) => a - b);
    const rawFloor = sortedSmoothed[Math.max(0, Math.floor(length * 0.12))];
    const merged = [];
    expanded.forEach(segment => {
      const previous = merged[merged.length - 1];
      if (!previous) {
        merged.push({ ...segment });
        return;
      }
      const gap = segment.start - previous.end - 1;
      const valley = gap > 0 ? Math.min(...residual.slice(previous.end + 1, segment.start)) : Infinity;
      const previousPeak = Math.max(...residual.slice(previous.start, previous.end + 1));
      const nextPeak = Math.max(...residual.slice(segment.start, segment.end + 1));
      const relativeValley = valley / Math.max(1e-9, Math.min(previousPeak, nextPeak));
      const rawValley = gap > 0 ? Math.min(...smoothed.slice(previous.end + 1, segment.start)) : Infinity;
      const rawPreviousPeak = Math.max(...smoothed.slice(previous.start, previous.end + 1));
      const rawNextPeak = Math.max(...smoothed.slice(segment.start, segment.end + 1));
      const relativeRawValley = (rawValley - rawFloor) / Math.max(1e-9, Math.min(rawPreviousPeak, rawNextPeak) - rawFloor);
      // A wide physical band often contains two local maxima. Merge the
      // maxima when the low-threshold shoulders touch, or when only a short,
      // shallow valley separates them. True adjacent lanes normally return
      // to the local membrane baseline and therefore remain separate.
      if (gap <= Math.max(1, minimumWidth - 1)
        || (gap <= mergeGap && (relativeValley >= 0.13 || relativeRawValley >= 0.28))) previous.end = Math.max(previous.end, segment.end);
      else merged.push({ ...segment });
    });
    // A WB lane is an integrated area, not a collection of local maxima.
    // Splitting a connected signal merely because it has two dark cores was
    // the main cause of one broad physical band becoming L1/L2.  Composite
    // splitting is therefore opt-in and is only useful for deliberately
    // resolving two bands that overlap along the same hand-drawn line.
    const allowCompositeSplitting = options.allowCompositeSplitting === true;
    const splitValleyRatio = Math.max(0.05, Math.min(0.6, Number(options.splitValleyRatio) || 0.16));
    const minimumPartWidth = Math.max(minimumWidth * 2, Math.round(length * 0.022));
    const splitComposite = (segment, depth = 0) => {
      const width = segment.end - segment.start + 1;
      if (depth >= 8 || width < minimumPartWidth * 2 + 1) return [segment];
      let best = null;
      const start = segment.start + minimumPartWidth;
      const end = segment.end - minimumPartWidth;
      for (let index = start; index <= end; index += 1) {
        if (smoothed[index] > smoothed[index - 1] || smoothed[index] > smoothed[index + 1]) continue;
        const leftPeak = Math.max(...smoothed.slice(segment.start, index));
        const rightPeak = Math.max(...smoothed.slice(index + 1, segment.end + 1));
        const smallerPeak = Math.min(leftPeak, rightPeak);
        const peakHeight = smallerPeak - rawFloor;
        if (peakHeight <= Math.max(1e-9, noise * 1.5)) continue;
        const ratio = (smoothed[index] - rawFloor) / peakHeight;
        const balance = Math.min(index - segment.start, segment.end - index)
          / Math.max(index - segment.start, segment.end - index);
        const score = ratio + (1 - balance) * 0.035;
        if (!best || score < best.score) best = { index, ratio, score };
      }
      if (!best || best.ratio > splitValleyRatio) return [segment];
      let valleyLeft = best.index;
      let valleyRight = best.index;
      const valleyLimit = smoothed[best.index] + Math.max(0.5, (Math.min(
        Math.max(...smoothed.slice(segment.start, best.index)),
        Math.max(...smoothed.slice(best.index + 1, segment.end + 1)),
      ) - smoothed[best.index]) * 0.08);
      while (valleyLeft > segment.start + minimumPartWidth && smoothed[valleyLeft - 1] <= valleyLimit) valleyLeft -= 1;
      while (valleyRight < segment.end - minimumPartWidth && smoothed[valleyRight + 1] <= valleyLimit) valleyRight += 1;
      const left = { start: segment.start, end: Math.max(segment.start, valleyLeft - 1) };
      const right = { start: Math.min(segment.end, valleyRight + 1), end: segment.end };
      return [...splitComposite(left, depth + 1), ...splitComposite(right, depth + 1)];
    };
    const separated = allowCompositeSplitting
      ? merged.flatMap(segment => splitComposite(segment))
      : merged;
    let segments = separated.map(segment => {
      const signalStart = segment.start;
      const signalEnd = segment.end;
      const local = residual.slice(signalStart, signalEnd + 1);
      const localPeak = Math.max(...local);
      const area = local.reduce((sum, value) => sum + value, 0);
      const weights = local.map(value => Math.max(0, value - lowThreshold * 0.35));
      const weightTotal = weights.reduce((sum, value) => sum + value, 0);
      const center = weightTotal > 0
        ? signalStart + weights.reduce((sum, value, index) => sum + value * index, 0) / weightTotal
        : (signalStart + signalEnd) / 2;
      const confidence = Math.max(0, Math.min(1,
        (1 - Math.exp(-localPeak / Math.max(noise * 5, 1e-9)))
        * Math.min(1, area / Math.max(noise * Math.max(minimumWidth, local.length) * 5, 1e-9))));
      return {
        start: Math.max(0, signalStart - padding),
        end: Math.min(length - 1, signalEnd + padding),
        signalStart,
        signalEnd,
        center,
        peak: localPeak,
        area,
        confidence,
      };
    }).filter(segment => segment.signalEnd - segment.signalStart + 1 >= minimumWidth
      && segment.peak >= highThreshold
      && segment.area >= noise * Math.max(minimumWidth, segment.signalEnd - segment.signalStart + 1) * 1.08);
    const expectedCount = Math.max(0, Math.round(Number(options.expectedCount) || 0));
    if (expectedCount && segments.length > expectedCount) {
      segments = segments
        .slice()
        .sort((left, right) => (right.area * (0.6 + right.confidence)) - (left.area * (0.6 + left.confidence)))
        .slice(0, expectedCount)
        .sort((left, right) => left.center - right.center);
    }
    return { segments, baseline, residual, highThreshold, lowThreshold, noise };
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

  function canvasUnitsPerPoint(canvasWidth, millimeters) {
    if (!finitePositive(canvasWidth) || !finitePositive(millimeters)) return 0;
    return Number(canvasWidth) * 25.4 / (Number(millimeters) * 72);
  }

  function figureFramePlacement(sourceWidth, sourceHeight, frameWidth, frameHeight, options = {}) {
    if (![sourceWidth, sourceHeight, frameWidth, frameHeight].every(finitePositive)) {
      return { scale: 0, offsetX: 0, offsetY: 0, drawWidth: 0, drawHeight: 0 };
    }
    const width = Number(frameWidth);
    const height = Number(frameHeight);
    const insetX = Math.max(0, Math.min(width / 3, Number(options.insetX) || 0));
    const insetY = Math.max(0, Math.min(height / 3, Number(options.insetY) || 0));
    const availableWidth = Math.max(1, width - insetX * 2);
    const availableHeight = Math.max(1, height - insetY * 2);
    const fitScale = Math.min(availableWidth / Number(sourceWidth), availableHeight / Number(sourceHeight));
    const zoom = Math.max(0.5, Math.min(2.4, (Number(options.zoomPercent) || 100) / 100));
    const scale = fitScale * zoom;
    const drawWidth = Number(sourceWidth) * scale;
    const drawHeight = Number(sourceHeight) * scale;
    return {
      scale,
      offsetX: (width - drawWidth) / 2,
      offsetY: (height - drawHeight) / 2 + Math.max(-220, Math.min(220, Number(options.verticalOffset) || 0)),
      drawWidth,
      drawHeight,
    };
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
    canvasUnitsPerPoint,
    classifySaturation,
    coomassieSampleResult,
    dpiToPixelsPerMeter,
    detectLineBands,
    editLaneAnnotations,
    filterBandGeometryOutliers,
    figureFramePlacement,
    linearRegression,
    pixelsForPhysicalWidth,
    readPngDpi,
    refineSignalBounds,
    replicateSummary,
    roiConsistency,
    separateNeighborRois,
    setPngDpi,
    signalBoundaryQuality,
    standardDilutionPlan,
    suggestedLoadVolume,
  };
}));
