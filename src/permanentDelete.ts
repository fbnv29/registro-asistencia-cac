export function confirmPermanentDelete(
  label: string,
  consequences: string,
): boolean {
  if (
    !window.confirm(
      `¿Borrar definitivamente ${label}? ${consequences} Esta acción no se puede deshacer.`,
    )
  )
    return false;
  return (
    window.prompt(
      `Segunda confirmación: escribe ELIMINAR para borrar definitivamente ${label}.`,
    ) === "ELIMINAR"
  );
}
