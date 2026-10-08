// ponytail: Intl supplies IANA rules; probe offsets around the local day, no date dependency.
export function zonedLocal(value: string, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
export function localInstants(value: string, zone: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw Error("Fecha local inválida.");
  const wall = Date.parse(value + "Z");
  const offsets = new Set<number>();
  for (let hour = -36; hour <= 36; hour += 6) {
    const instant = wall + hour * 3600000;
    offsets.add(Date.parse(zonedLocal(new Date(instant).toISOString(), zone) + "Z") - instant);
  }
  return [...offsets]
    .map((offset) => new Date(wall - offset).toISOString())
    .filter((instant) => zonedLocal(instant, zone) === value)
    .sort();
}
export function interviewInstant(value: string, zone: string, occurrence: string) {
  const choices = localInstants(value, zone);
  if (!choices.length) throw Error("Esta hora no existe en la zona seleccionada. Elige otra hora.");
  if (choices.length > 1 && !occurrence)
    throw Error("Esta hora ocurre dos veces. Selecciona la primera o segunda ocurrencia.");
  // An occurrence choice only matters when the local time repeats.
  return choices[occurrence === "second" && choices.length > 1 ? 1 : 0]!;
}
