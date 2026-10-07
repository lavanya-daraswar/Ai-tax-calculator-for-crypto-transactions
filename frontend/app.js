// INNOBLOCK 2.0 starter frontend. Settings (network, contract, backend) live in config.js.

const NETWORK = NETWORKS[ACTIVE_NETWORK] || NETWORKS.sepolia;
const CHAIN_ID_HEX = "0x" + NETWORK.chainId.toString(16);

// Read-only connection to the chain: works without a wallet, used for verification
const readProvider = new ethers.JsonRpcProvider(NETWORK.rpcUrl, NETWORK.chainId, { staticNetwork: true });
const readContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, readProvider);

let signer = null; // set once the wallet is connected

const $ = (id) => document.getElementById(id);

/** Explorer link for a transaction. */
function txUrl(hash) {
  return `${NETWORK.explorer}/tx/${hash}`;
}

/** Show a status line (pending / confirmed / failed), with an explorer link when there is a transaction. */
function setStatus(el, state, message, txHash) {
  el.className = `status ${state}`;
  el.textContent = message;
  if (txHash) {
    const link = document.createElement("a");
    link.href = txUrl(txHash);
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "View transaction ↗";
    el.append(" ", link);
  }
}

/** Turn wallet and ethers errors into messages a user can act on. */
function friendlyError(err) {
  if (err?.code === "ACTION_REJECTED") return "You rejected the request in your wallet.";
  if (err?.code === "INSUFFICIENT_FUNDS") return `Your wallet has no test ${NETWORK.currency}. Get some from a faucet.`;
  if (err?.code === "CALL_EXCEPTION") return "The contract rejected this call. Check the contract address and network in config.js.";
  if (err?.code === "BAD_DATA") return "No contract found at CONTRACT_ADDRESS on this network. Check config.js.";
  if (err?.code === "NETWORK_ERROR") return "Network problem. Check your connection and try again.";
  return err?.shortMessage || err?.message || String(err);
}

/** Call the backend and return its JSON, with a clear message if it can't be reached. */
async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, { headers: { "Content-Type": "application/json" }, ...options });
  } catch {
    throw new Error(`Can't reach the backend at ${BACKEND_URL}. Is it running? A sleeping free Render service takes about a minute to wake up.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Backend error ${res.status}`);
  return data;
}

/** Ask the wallet to switch to our network, adding the network first if the wallet doesn't know it. */
async function switchNetwork() {
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
  } catch (err) {
    const code = err.code ?? err.data?.originalError?.code;
    if (code !== 4902) throw err; // 4902 = this network hasn't been added to the wallet yet
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: CHAIN_ID_HEX,
        chainName: NETWORK.name,
        rpcUrls: [NETWORK.rpcUrl],
        blockExplorerUrls: [NETWORK.explorer],
        nativeCurrency: { name: NETWORK.currency, symbol: NETWORK.currency, decimals: 18 },
      }],
    });
  }
}

/** Step 1: connect the wallet, switch it to our network, show address and balance. */
async function connectWallet() {
  const el = $("connect-status");
  if (!window.ethereum) {
    setStatus(el, "failed", "No wallet found. Install MetaMask, or open this page inside the MetaMask mobile app.");
    return;
  }
  try {
    setStatus(el, "pending", "Approve the connection in your wallet…");
    await window.ethereum.request({ method: "eth_requestAccounts" });
    await switchNetwork();
    const provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    const address = await signer.getAddress();
    const balance = await provider.getBalance(address);
    $("wallet-address").textContent = address;
    $("wallet-balance").textContent = `${Number(ethers.formatEther(balance)).toFixed(4)} ${NETWORK.currency}`;
    $("connect-btn").textContent = "Connected";
    setStatus(el, "confirmed", `Connected to ${NETWORK.name}.`);
  } catch (err) {
    setStatus(el, "failed", friendlyError(err));
  }
}

/** Step 2: the USER signs. Hash the text in the browser and store the hash from their wallet. */
async function storeFromWallet() {
  const el = $("wallet-status");
  const text = $("wallet-text").value.trim();
  if (!text) return setStatus(el, "failed", "Type something first.");
  if (!signer) return setStatus(el, "failed", "Connect your wallet first (step 1).");
  try {
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
    const hash = ethers.sha256(ethers.toUtf8Bytes(text));
    setStatus(el, "pending", "Confirm the transaction in your wallet…");
    const tx = await contract.store(hash);
    setStatus(el, "pending", "Pending: waiting for the network to confirm…", tx.hash);
    const receipt = await tx.wait(); // throws if the transaction fails
    const event = receipt.logs
      .map((log) => { try { return contract.interface.parseLog(log); } catch { return null; } })
      .find((parsed) => parsed?.name === "RecordStored");
    setStatus(el, "confirmed", `Confirmed: stored as record #${event ? event.args.id : "?"}. Check it in step 4 with the same text.`, tx.hash);
  } catch (err) {
    setStatus(el, "failed", `Failed: ${friendlyError(err)}`, err?.receipt?.hash);
  }
}

/** Step 3a: ask the backend's AI for a decision. */
async function askAI() {
  const el = $("ai-status");
  const prompt = $("ai-prompt").value.trim();
  if (!prompt) return setStatus(el, "failed", "Write a question for the AI first.");
  setStatus(el, "pending", "Asking the AI…");
  try {
    const data = await api("/ai/decide", { method: "POST", body: JSON.stringify({ prompt }) });
    $("ai-decision").value = data.decision;
    setStatus(el, "confirmed", data.demo
      ? "Demo answer. Set API_KEY in backend/.env to use a real model."
      : "The AI answered. Review it, then store it on-chain.");
  } catch (err) {
    setStatus(el, "failed", err.message);
  }
}

/** Step 3b: the BACKEND signs. It hashes the decision, stores the hash and saves the text. */
async function storeDecision() {
  const el = $("ai-status");
  const text = $("ai-decision").value.trim();
  if (!text) return setStatus(el, "failed", "Ask the AI first, or type a decision.");
  setStatus(el, "pending", "Pending: the backend is signing and sending the transaction…");
  try {
    const record = await api("/records", { method: "POST", body: JSON.stringify({ text }) });
    setStatus(el, "confirmed", `Confirmed: stored as record #${record.id}.`, record.txHash);
    loadRecords();
  } catch (err) {
    setStatus(el, "failed", `Failed: ${err.message}`);
  }
}

/** Step 4: re-hash the text in the browser and compare it with the hash stored on-chain. */
async function verifyRecord(id, text, resultEl) {
  resultEl.className = "result";
  resultEl.textContent = "Checking…";
  try {
    const ok = await readContract.verify(id, ethers.sha256(ethers.toUtf8Bytes(text)));
    resultEl.className = `result ${ok ? "ok" : "bad"}`;
    resultEl.textContent = ok ? "✔ Verified on-chain" : "✘ Does not match the chain";
  } catch (err) {
    resultEl.className = "result bad";
    resultEl.textContent = friendlyError(err);
  }
}

/** One row in the records list: editable text, a Verify button, and the transaction link. */
function renderRecord(record) {
  const row = document.createElement("div");
  row.className = "record";
  const id = document.createElement("span");
  id.className = "rid";
  id.textContent = `#${record.id}`;
  const input = document.createElement("input");
  input.value = record.text;
  const button = document.createElement("button");
  button.className = "secondary";
  button.textContent = "Verify";
  const result = document.createElement("span");
  result.className = "result";
  const link = document.createElement("a");
  link.href = txUrl(record.txHash);
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "tx ↗";
  button.onclick = () => verifyRecord(record.id, input.value, result);
  row.append(id, input, button, result, link);
  return row;
}

/** Load the records the backend saved and list them. */
async function loadRecords() {
  const list = $("records");
  list.textContent = "Loading…";
  try {
    const { records } = await api("/records");
    list.textContent = records.length ? "" : "No records yet. Store an AI decision in step 3.";
    records.forEach((record) => list.append(renderRecord(record)));
  } catch (err) {
    list.textContent = err.message;
  }
}

/** Wire up the page and warn about anything left unconfigured in config.js. */
function init() {
  $("network-badge").textContent = NETWORK.name;
  const problems = [];
  if (!NETWORKS[ACTIVE_NETWORK]) problems.push(`ACTIVE_NETWORK "${ACTIVE_NETWORK}" is not in NETWORKS, so Sepolia is used.`);
  if (/^0x0{40}$/.test(CONTRACT_ADDRESS)) problems.push("Set CONTRACT_ADDRESS in frontend/config.js to your deployed contract.");
  if (problems.length) {
    $("setup-warning").textContent = problems.join(" ");
    $("setup-warning").classList.remove("hidden");
  }

  $("connect-btn").onclick = connectWallet;
  $("wallet-store-btn").onclick = storeFromWallet;
  $("ai-ask-btn").onclick = askAI;
  $("ai-store-btn").onclick = storeDecision;
  $("refresh-btn").onclick = loadRecords;
  $("check-btn").onclick = () => verifyRecord(Number($("check-id").value), $("check-text").value, $("check-result"));

  // Reload when the user switches account or network in the wallet, so nothing goes stale
  window.ethereum?.on?.("chainChanged", () => location.reload());
  window.ethereum?.on?.("accountsChanged", () => location.reload());

  loadRecords();
}
init();
// ============================================================
// PS40 - Cost Basis and Gain/Loss Calculation
// ============================================================

function calculateTax() {
  if (!taxTransactions.length) {
    $("tax-summary").innerHTML =
      "<p>Please load the demo transactions first.</p>";
    return;
  }

  const method = $("cost-basis-method").value;

  // Only transactions that dispose of an asset create a gain/loss.
  const buys = taxTransactions
    .filter(tx => tx.classification === "BUY")
    .map(tx => ({
      asset: tx.asset,
      quantity: tx.quantity,
      costPerUnit: tx.price / tx.quantity,
      remaining: tx.quantity
    }));

  let totalGain = 0;
  let breakdown = [];

  for (const tx of taxTransactions) {

    if (
      tx.classification !== "SELL" &&
      tx.classification !== "SWAP"
    ) {
      continue;
    }

    const quantitySold = tx.quantity;
    const proceeds = tx.price;

    let remainingToMatch = quantitySold;
    let costBasis = 0;

    // FIFO = oldest purchase first
    // LIFO = newest purchase first
    const availableLots =
      method === "FIFO"
        ? buys
        : [...buys].reverse();

    for (const lot of availableLots) {

      if (lot.asset !== "ETH") {
        continue;
      }

      if (remainingToMatch <= 0) {
        break;
      }

      const used = Math.min(
        remainingToMatch,
        lot.remaining
      );

      costBasis += used * lot.costPerUnit;

      lot.remaining -= used;
      remainingToMatch -= used;
    }

    const gain = proceeds - costBasis;

    totalGain += gain;

    breakdown.push({
      date: tx.date,
      type: tx.classification,
      asset: tx.asset,
      quantity: quantitySold,
      proceeds: proceeds,
      costBasis: costBasis,
      gain: gain
    });
  }

  const income = taxTransactions
    .filter(tx => tx.classification === "INCOME")
    .reduce((sum, tx) => sum + tx.price, 0);

  $("tax-summary").innerHTML = `
    <div class="tax-result">

      <h3>Tax Summary</h3>

      <p>
        <strong>Cost-basis method:</strong>
        ${method}
      </p>

      <p>
        <strong>Total capital gain/loss:</strong>
        ${totalGain.toFixed(2)} USDT
      </p>

      <p>
        <strong>Income:</strong>
        ${income.toFixed(2)} USDT
      </p>

      <h3>Transaction Breakdown</h3>

      ${breakdown.map(item => `
        <div class="record">
          <strong>${item.date}</strong>
          <span>${item.type}</span>
          <span>${item.quantity} ${item.asset}</span>
          <span>
            Proceeds: ${item.proceeds.toFixed(2)}
          </span>
          <span>
            Cost: ${item.costBasis.toFixed(2)}
          </span>
          <span>
            Gain/Loss: ${item.gain.toFixed(2)}
          </span>
        </div>
      `).join("")}
    </div>
  `;
}

$("calculate-tax-btn").onclick = calculateTax;
// ============================================================
// PS40 - Crypto Tax Calculator
// ============================================================

const demoTransactions = [
  {
    date: "2026-01-10",
    type: "Buy",
    asset: "ETH",
    quantity: 0.5,
    price: 1000,
    currency: "USDT"
  },
  {
    date: "2026-02-15",
    type: "Buy",
    asset: "ETH",
    quantity: 0.3,
    price: 750,
    currency: "USDT"
  },
  {
    date: "2026-03-20",
    type: "Sell",
    asset: "ETH",
    quantity: 0.4,
    price: 1200,
    currency: "USDT"
  },
  {
    date: "2026-04-05",
    type: "Swap",
    asset: "ETH → BTC",
    quantity: 0.2,
    price: 700,
    currency: "USDT"
  },
  {
    date: "2026-04-20",
    type: "Transfer",
    asset: "ETH",
    quantity: 0.1,
    price: 0,
    currency: "N/A"
  },
  {
    date: "2026-05-01",
    type: "Income",
    asset: "ETH",
    quantity: 0.05,
    price: 150,
    currency: "USDT"
  }
];

let taxTransactions = [];

function renderTaxTransactions() {
  const container = $("tax-transactions");

  if (!taxTransactions.length) {
    container.innerHTML = "<p>No transactions loaded.</p>";
    return;
  }

  container.innerHTML = taxTransactions.map((tx, index) => `
    <div class="record">
      <strong>#${index + 1}</strong>

      <span>${tx.date}</span>

      <span>
        <strong>Transaction:</strong>
        ${tx.asset}
      </span>

      <span>
        <strong>Amount:</strong>
        ${tx.quantity}
      </span>

      <span>
        <strong>Value:</strong>
        ${tx.price} ${tx.currency}
      </span>

      <div class="ai-line">
  <strong>AI Classification:</strong>
  ${tx.classification || "Not classified yet"}
   ${
    tx.needsReview
      ? " ⚠️ Needs manual review"
      : ""
  }
</div>

${
  tx.aiResult
    ? `
      <div class="ai-line">
        <strong>AI Explanation:</strong>
        ${tx.aiResult}
      </div>
    `
    : ""
}
    </div>
  `).join("");
}
function loadDemoTransactions() {
  taxTransactions = demoTransactions.map(tx => ({ ...tx }));
  renderTaxTransactions();

  $("classification-status").textContent =
    "Demo transactions loaded. Ready for AI classification.";
}

async function classifyTransactions() {
  if (!taxTransactions.length) {
    $("classification-status").textContent =
      "Load transactions first.";
    return;
  }

  $("classification-status").textContent =
    "AI is classifying transactions...";

  try {
    for (const tx of taxTransactions) {

      const transactionText = `
Date: ${tx.date}
Asset: ${tx.asset}
Quantity: ${tx.quantity}
Price: ${tx.price} ${tx.currency}
Transaction type hint: ${tx.type}
      `.trim();

      const response = await fetch("http://127.0.0.1:5000/ai/decide", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          prompt: `Classify this crypto transaction as exactly one of BUY, SELL, SWAP, TRANSFER, or INCOME.

${transactionText}

Return the classification first, followed by one short reason.`
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "AI request failed");
      }

      tx.aiResult = data.decision;

      const result = data.decision.toUpperCase();

      if (result.includes("BUY")) {
        tx.classification = "BUY";
      } else if (result.includes("SELL")) {
        tx.classification = "SELL";
      } else if (result.includes("SWAP")) {
        tx.classification = "SWAP";
      } else if (result.includes("TRANSFER")) {
        tx.classification = "TRANSFER";
      } else if (result.includes("INCOME")) {
        tx.classification = "INCOME";
      } else {
        tx.classification = "REVIEW";
        tx.needsReview = true;
      }
    }

    renderTaxTransactions();

    $("classification-status").textContent =
      "AI classification complete. Review the classifications below.";

  } catch (error) {

    console.error(error);

    $("classification-status").textContent =
      "AI classification failed: " + error.message;
  }
}
$("load-demo-btn").onclick = loadDemoTransactions;
$("classify-btn").onclick = classifyTransactions;
$("calculate-tax-btn").onclick = calculateTax;
$("csv-file").addEventListener("change", handleCSVImport);

function handleCSVImport(event) {
  const file = event.target.files[0];

  if (!file) return;

  const reader = new FileReader();

  reader.onload = function(e) {
    const text = e.target.result;

    const lines = text.trim().split("\n");

    if (lines.length < 2) {
      alert("CSV file is empty.");
      return;
    }

    const headers = lines[0].split(",").map(h => h.trim());

    taxTransactions = lines.slice(1).map(line => {
      const values = line.split(",").map(v => v.trim());

      const row = {};

      headers.forEach((header, index) => {
        row[header] = values[index];
      });

      return {
        date: row.date,
        type: row.type,
        asset: row.asset,
        quantity: Number(row.quantity),
        price: Number(row.price),
        currency: row.currency
      };
    });

    renderTaxTransactions();

    $("classification-status").textContent =
      `${taxTransactions.length} transactions imported from CSV.`;
  };

  reader.readAsText(file);
}
$("export-tax-btn").onclick = exportTaxSummary;

async function exportTaxSummary() {
  if (!taxTransactions.length) {
    alert("Please load or import transactions first.");
    return;
  }

  const method = $("cost-basis-method").value;

  const summary = {
    generatedAt: new Date().toISOString(),
    costBasisMethod: method,
    transactions: taxTransactions.map(tx => ({
      date: tx.date,
      type: tx.classification || tx.type,
      asset: tx.asset,
      quantity: tx.quantity,
      price: tx.price,
      currency: tx.currency,
      aiExplanation: tx.aiResult || ""
    }))
  };

  const text = JSON.stringify(summary, null, 2);
const hashBuffer = await crypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(text)
);

const hashArray = Array.from(new Uint8Array(hashBuffer));
const hash = hashArray
  .map(byte => byte.toString(16).padStart(2, "0"))
  .join("");
alert("SHA-256 Hash:\n" + hash);
$("tax-hash").innerHTML =
  "<strong>Tax Summary SHA-256:</strong> " + hash;
console.log("Tax Summary SHA-256 Hash:", hash);
  const blob = new Blob([text], {
    type: "application/json"
  });

  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = "crypto-tax-summary.json";
  link.click();

  URL.revokeObjectURL(url);
}
async function storeTaxHashOnChain() {
  const status = $("tax-chain-status");
  const hashText = $("tax-hash").textContent;

  if (!hashText) {
    setStatus(status, "failed", "Export the tax summary first.");
    return;
  }

  if (!signer) {
    setStatus(status, "failed", "Connect your wallet first.");
    return;
  }

  const hash = hashText
  .replace("Tax Summary SHA-256:", "")
  .trim();

const hashBytes = "0x" + hash;

  try {
    const contract = new ethers.Contract(
      CONTRACT_ADDRESS,
      CONTRACT_ABI,
      signer
    );

    setStatus(
      status,
      "pending",
      "Confirm the transaction in MetaMask…"
    );

    const tx = await contract.store(hashBytes);

    setStatus(
      status,
      "pending",
      "Pending: waiting for Sepolia confirmation…",
      tx.hash
    );

    const receipt = await tx.wait();

    const event = receipt.logs
      .map((log) => {
        try {
          return contract.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed?.name === "RecordStored");

    setStatus(
      status,
      "confirmed",
      `Tax summary hash stored on Sepolia as record #${
        event ? event.args.id : "?"
      }.`,
      tx.hash
    );

  } catch (err) {
    setStatus(
      status,
      "failed",
      `Failed: ${friendlyError(err)}`,
      err?.receipt?.hash
    );
  }
}
$("store-tax-hash-btn").onclick = storeTaxHashOnChain;
