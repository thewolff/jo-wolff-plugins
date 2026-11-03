// The client bundle of a client-rendered page under a server-set head: it renders the body and adds an
// Organization JSON-LD block (do-not-flag DNF-21 and NF-06).
const app = document.getElementById("app");
app.innerHTML = `
<main>
<h1>Kestrel Lane Bikes</h1>
<p>Workshop repairs for road, gravel and town bikes, in a small workshop behind the station. Book a service slot, drop the bike off before work and collect it the same evening.</p>
<h2>Wheel builds</h2>
<p>Hand-built wheel sets laced to your rims and hubs, trued and tensioned on the stand, with a second check after the first hundred kilometres.</p>
<h2>Bike fitting</h2>
<p>Fitting sessions take ninety minutes and end with a written report of every change made to saddle, bars and cleats.</p>
</main>`;
const ld = document.createElement("script");
ld.type = "application/ld+json";
ld.textContent = JSON.stringify({ "@context": "https://schema.org", "@type": "Organization", name: "Kestrel Lane Bikes", url: "https://127.0.0.1:47402/" });
document.head.appendChild(ld);
