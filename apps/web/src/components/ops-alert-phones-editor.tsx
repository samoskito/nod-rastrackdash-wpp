"use client";

import { X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

const PHONE_MIN_DIGITS = 10;
const PHONE_MAX_DIGITS = 13;
const MAX_PHONES = 10;

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function normalizePhones(phones: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const phone of phones) {
    const digits = digitsOnly(phone);
    if (digits && !seen.has(digits)) {
      seen.add(digits);
      normalized.push(digits);
    }
  }

  return normalized;
}

export function OpsAlertPhonesEditor({
  name = "alertPhones",
  initialPhones,
}: {
  name?: string;
  initialPhones: string[];
}) {
  const [phones, setPhones] = useState<string[]>(() =>
    normalizePhones(initialPhones),
  );
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function addPhone() {
    const digits = digitsOnly(draft);

    if (!digits) {
      setError("Informe um telefone.");
      return;
    }

    if (digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) {
      setError("Telefone deve ter entre 10 e 13 dígitos.");
      return;
    }

    if (phones.includes(digits)) {
      setError("Esse telefone já foi adicionado.");
      return;
    }

    if (phones.length >= MAX_PHONES) {
      setError(`Limite de ${MAX_PHONES} telefones atingido.`);
      return;
    }

    setPhones((current) => [...current, digits]);
    setDraft("");
    setError(null);
  }

  function removePhone(phone: string) {
    setPhones((current) => current.filter((entry) => entry !== phone));
  }

  function handleDraftKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    addPhone();
  }

  return (
    <div className="ops-alert-phones-field">
      <span className="field-label">Telefones</span>
      {phones.length > 0 ? (
        <ul className="ops-alert-phones-list">
          {phones.map((phone) => (
            <li className="ops-alert-phone-chip" key={phone}>
              <input name={name} type="hidden" value={phone} />
              <span>{phone}</span>
              <button
                aria-label={`Remover ${phone}`}
                className="ops-alert-phone-remove"
                onClick={() => removePhone(phone)}
                type="button"
              >
                <X size={13} strokeWidth={2.5} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ops-alert-phones-empty">
          Nenhum telefone cadastrado. Adicione ao menos um número para ativar os
          alertas.
        </p>
      )}
      <div className="ops-alert-phones-add-row">
        <input
          data-presentation-sensitive-field="true"
          inputMode="numeric"
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={handleDraftKeyDown}
          placeholder="5511999999999"
          value={draft}
        />
        <button
          className="button"
          disabled={phones.length >= MAX_PHONES}
          onClick={addPhone}
          type="button"
        >
          Adicionar
        </button>
      </div>
      {error ? (
        <small className="ops-alert-phones-error">{error}</small>
      ) : (
        <small>DDI+DDD+número, só dígitos. Até {MAX_PHONES} telefones.</small>
      )}
    </div>
  );
}
