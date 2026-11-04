import type { Metadata } from "next";

// FW-NEXT-05: a title template without a default.
// FW-NEXT-04: relative canonical and Open Graph image with no metadataBase in this root layout.
// FW-NEXT-23: viewport and themeColor inside metadata.
export const metadata: Metadata = {
	title: {
		template: "%s | Fern Studio",
	},
	description: "Fern Studio designs gardens and planting plans for small urban spaces.",
	alternates: {
		canonical: "/",
		languages: { "en-GB": "https://fern.example/en-gb", "de-DE": "/de" },
	},
	openGraph: {
		url: "https://fern.example/",
		images: ["/og/home.png", { url: "https://fern.example/og/alt.png", alt: "A courtyard garden, planted" }],
	},
	viewport: "width=device-width, initial-scale=1",
	themeColor: "#2f6f4f",
};

export default function SiteLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	);
}
