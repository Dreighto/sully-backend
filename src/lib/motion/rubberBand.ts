/**
 * UIScrollView rubber-band resistance for overscroll past bounds.
 * f(x, d, c) = (x * d * c) / (d + c * x)
 *
 * @param overscrollPx distance past the bound (always positive)
 * @param dimension bound size (sheet height, drawer width, etc.)
 * @param c resistance constant (~0.55 on iOS)
 */
export function rubberBandOverscroll(overscrollPx: number, dimension: number, c = 0.55): number {
	if (overscrollPx <= 0 || dimension <= 0) return 0;
	return (overscrollPx * dimension * c) / (dimension + c * overscrollPx);
}

/** Apply rubber-band when dragging past open (negative) or past closed (positive). */
export function rubberBandClamped(
	positionPx: number,
	openPx: number,
	closedPx: number,
	dimensionPx: number
): number {
	if (positionPx < openPx) {
		const overscroll = openPx - positionPx;
		return openPx - rubberBandOverscroll(overscroll, dimensionPx);
	}
	if (positionPx > closedPx) {
		const overscroll = positionPx - closedPx;
		return closedPx + rubberBandOverscroll(overscroll, dimensionPx);
	}
	return positionPx;
}
