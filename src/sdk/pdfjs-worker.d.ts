// Partie « worker » de pdf.js, chargée sur le fil principal par `engines.ts` (le cadre des pages interdit les
// workers). Le paquet ne la type pas.
declare module "pdfjs-dist/build/pdf.worker.min.mjs";
