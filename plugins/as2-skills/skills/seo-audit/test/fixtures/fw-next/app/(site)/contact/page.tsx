"use client";

import { useState } from "react";

// FW-NEXT-02: metadata exported from a Client Component is not applied.
export const metadata = {
	title: "Contact",
	description: "Book a garden consultation.",
};

export default function Contact() {
	const [sent, setSent] = useState(false);
	return <button onClick={() => setSent(true)}>{sent ? "Thanks" : "Send"}</button>;
}
