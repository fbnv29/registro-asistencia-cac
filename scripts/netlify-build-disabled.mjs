console.error(
  "CAC: builds remotos desactivados para evitar publicaciones y consumo automático. " +
    "Prepara localmente con npm run netlify:prepare. Publica solo con autorización explícita, " +
    "mediante Netlify CLI --no-build. Mantén Stopped builds en el panel de Netlify.",
);
process.exitCode = 1;
