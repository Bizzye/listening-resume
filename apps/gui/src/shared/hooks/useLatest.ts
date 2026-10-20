import { useLayoutEffect, useRef } from "react";

/** Ref that always holds the latest value — lets effects call fresh callbacks without re-subscribing. */
export function useLatest<T>(value: T) {
	const ref = useRef(value);
	useLayoutEffect(() => {
		ref.current = value;
	});
	return ref;
}
