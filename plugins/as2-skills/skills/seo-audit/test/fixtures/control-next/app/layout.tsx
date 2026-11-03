import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
	title: {
		default: "Quayside Books: new and secondhand books on the harbour front",
		template: "%s | Quayside Books",
	},
	description:
		"Quayside Books sells new and secondhand books on the harbour front: local history, sea fiction, maps and charts, with a reading corner and a monthly book club that meets upstairs.",
	icons: { icon: "/favicon.svg" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

const jsonLd = { "@context": "https://schema.org", "@type": "WebSite", name: "Quayside Books", url: "https://127.0.0.1:47605/" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<head>
				<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
			</head>
			<body>{children}</body>
		</html>
	);
}
