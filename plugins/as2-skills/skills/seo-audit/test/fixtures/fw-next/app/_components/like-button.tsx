"use client";

import { useState } from "react";

// A private folder (`_components`) is not a route; a client component without metadata is fine.
export function LikeButton() {
	const [n, setN] = useState(0);
	return <button onClick={() => setN(n + 1)}>Like {n}</button>;
}
