const drafts = new Set<object>();
export function markDraft(key: object, dirty: boolean) {
  if (dirty) drafts.add(key);
  else drafts.delete(key);
}
export function confirmLeave() {
  return (
    !drafts.size ||
    window.confirm("Hay cambios sin guardar. ¿Quieres salir y descartarlos?")
  );
}
window.addEventListener("beforeunload", (event) => {
  if (drafts.size) {
    event.preventDefault();
    event.returnValue = "";
  }
});
