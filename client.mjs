const topics = { delivery: "Доставка", pricing: "Стоимость", other: "Другое" };

export function mount({ form, message, result, fetchImpl = fetch }) {
  let latest = 0;
  let active;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = ++latest;
    active?.abort();
    const text = message.value.trim();
    result.textContent = "";
    if (!text) {
      result.textContent = "Введите текст заявки.";
      return;
    }
    active = new AbortController();
    const controller = active;
    const timer = setTimeout(() => controller.abort(), 5000);
    result.textContent = "Разбираем заявку…";
    try {
      const reply = await fetchImpl("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      const data = await reply.json();
      if (id !== latest) return;
      if (reply.status === 400 && data.status === "invalid_input") {
        result.textContent = "Введите непустой текст заявки.";
      } else if (reply.ok && data.status === "ready"
          && Object.hasOwn(topics, data.topic)
          && typeof data.draft === "string" && data.draft.trim()) {
        result.textContent = `Тема: ${topics[data.topic]}\n\nЧерновик ответа:\n${data.draft.trim()}\n\nПроверьте ответ перед отправкой клиенту.`;
      } else {
        throw new Error("Manual review required");
      }
    } catch {
      if (id === latest) {
        result.textContent = "Нужен ручной разбор. Не удалось подготовить ответ. Текст заявки сохранён в поле выше — обработайте её вручную или повторите попытку.";
      }
    } finally {
      clearTimeout(timer);
    }
  });
}

if (typeof document !== "undefined") {
  mount({ form: document.querySelector("form"), message: document.querySelector("#message"), result: document.querySelector("#result") });
}
