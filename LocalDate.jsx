"use client";

import { useEffect, useState } from "react";

export default function LocalDate({ value }) {
  const [label, setLabel] = useState("");

  useEffect(() => {
    if (!value) {
      setLabel("Time unavailable");
      return;
    }

    const date = new Date(value);
    setLabel(Number.isNaN(date.getTime())
      ? "Time unavailable"
      : date.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }));
  }, [value]);

  return <time dateTime={value || undefined}>{label || "Local time…"}</time>;
}
