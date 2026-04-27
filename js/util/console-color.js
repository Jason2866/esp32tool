const ANSI_256 = (() => {
    const t = [];
    // Standard colors 0-7
    t[0] = "rgb(0,0,0)";
    t[1] = "rgb(128,0,0)";
    t[2] = "rgb(0,128,0)";
    t[3] = "rgb(128,128,0)";
    t[4] = "rgb(0,0,128)";
    t[5] = "rgb(128,0,128)";
    t[6] = "rgb(0,128,128)";
    t[7] = "rgb(192,192,192)";
    // Bright colors 8-15
    t[8] = "rgb(128,128,128)";
    t[9] = "rgb(255,0,0)";
    t[10] = "rgb(0,255,0)";
    t[11] = "rgb(255,255,0)";
    t[12] = "rgb(99,153,255)";
    t[13] = "rgb(255,0,255)";
    t[14] = "rgb(0,255,255)";
    t[15] = "rgb(255,255,255)";
    // 6x6x6 color cube 16-231
    for (let i = 0; i < 216; i++) {
        const r = Math.floor(i / 36);
        const g = Math.floor((i % 36) / 6);
        const b = i % 6;
        t[16 + i] =
            "rgb(" +
                (r ? r * 40 + 55 : 0) +
                "," +
                (g ? g * 40 + 55 : 0) +
                "," +
                (b ? b * 40 + 55 : 0) +
                ")";
    }
    // Grayscale ramp 232-255
    for (let i = 0; i < 24; i++) {
        const v = i * 10 + 8;
        t[232 + i] = "rgb(" + v + "," + v + "," + v + ")";
    }
    return t;
})();
// Maps 256-color indices 0–7 to the named CSS class tokens so that
// \x1b[38;5;1m renders the same red as \x1b[31m.
const ANSI_NAMED = [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
];
export class ColoredConsole {
    constructor(targetElement) {
        this.targetElement = targetElement;
        this.state = {
            bold: false,
            italic: false,
            underline: false,
            strikethrough: false,
            foregroundColor: null,
            backgroundColor: null,
            fgRgb: null,
            bgRgb: null,
            dim: false,
            reverse: false,
            carriageReturn: false,
            lines: [],
            secret: false,
            blink: false,
            rapidBlink: false,
        };
    }
    logs() {
        if (this.state.lines.length > 0) {
            this.processLines();
        }
        return this.targetElement.innerText;
    }
    processLine(line) {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
        // eslint-disable-next-line no-control-regex
        const re = /(?:\x1B|\\x1B)(?:\[(.*?)([@-~])|\].*?(?:\x07|\x1B\\))/g;
        let i = 0;
        const lineSpan = document.createElement("span");
        lineSpan.classList.add("line");
        const addSpan = (content) => {
            const span = document.createElement("span");
            if (this.state.bold)
                span.classList.add("log-bold");
            if (this.state.dim)
                span.classList.add("log-dim");
            if (this.state.italic)
                span.classList.add("log-italic");
            if (this.state.underline)
                span.classList.add("log-underline");
            if (this.state.strikethrough)
                span.classList.add("log-strikethrough");
            if (this.state.secret)
                span.classList.add("log-secret");
            if (this.state.blink)
                span.classList.add("log-blink");
            if (this.state.rapidBlink)
                span.classList.add("log-rapid-blink");
            // Resolve colors with reverse-video support
            let fgRgb = this.state.fgRgb;
            let bgRgb = this.state.bgRgb;
            let fg = this.state.foregroundColor;
            let bg = this.state.backgroundColor;
            if (this.state.reverse) {
                fgRgb = this.state.bgRgb;
                bgRgb = this.state.fgRgb;
                fg = this.state.backgroundColor;
                bg = this.state.foregroundColor;
                // When one side is unset, fill in the terminal defaults so the
                // swap is always visible (fg default=#ddd, bg default=#1c1c1c).
                if (!fgRgb && !fg && !bgRgb && !bg) {
                    span.classList.add("log-reverse");
                }
                else {
                    if (!fgRgb && !fg)
                        fgRgb = "rgb(28,28,28)";
                    if (!bgRgb && !bg)
                        bgRgb = "rgb(221,221,221)";
                }
            }
            // Inline rgb() style takes priority over CSS class
            if (fgRgb) {
                span.style.color = fgRgb;
            }
            else if (fg !== null) {
                span.classList.add(`log-fg-${fg}`);
            }
            if (bgRgb) {
                span.style.backgroundColor = bgRgb;
            }
            else if (bg !== null) {
                span.classList.add(`log-bg-${bg}`);
            }
            span.appendChild(document.createTextNode(content));
            lineSpan.appendChild(span);
            if (this.state.secret) {
                const redacted = document.createElement("span");
                redacted.classList.add("log-secret-redacted");
                redacted.appendChild(document.createTextNode("[redacted]"));
                lineSpan.appendChild(redacted);
            }
        };
        while (true) {
            const match = re.exec(line);
            if (match === null)
                break;
            const j = match.index;
            addSpan(line.substring(i, j));
            i = j + match[0].length;
            // Only process SGR sequences (final byte 'm'); skip cursor, erase, etc.
            if (match[1] === undefined || match[2] !== "m")
                continue;
            const rawCodes = match[1] === "" ? [""] : match[1].split(";");
            const codes = [];
            let invalidSgr = false;
            for (const rawCode of rawCodes) {
                if (rawCode === "") {
                    codes.push(0);
                    continue;
                }
                if (!/^\d+$/.test(rawCode)) {
                    invalidSgr = true;
                    break;
                }
                codes.push(Number(rawCode));
            }
            if (invalidSgr)
                continue;
            for (let ci = 0; ci < codes.length; ci++) {
                const code = codes[ci];
                switch (code) {
                    case 0:
                        this.state.bold = false;
                        this.state.dim = false;
                        this.state.italic = false;
                        this.state.underline = false;
                        this.state.strikethrough = false;
                        this.state.foregroundColor = null;
                        this.state.backgroundColor = null;
                        this.state.fgRgb = null;
                        this.state.bgRgb = null;
                        this.state.reverse = false;
                        this.state.secret = false;
                        this.state.blink = false;
                        this.state.rapidBlink = false;
                        break;
                    case 1:
                        this.state.bold = true;
                        break;
                    case 2:
                        this.state.dim = true;
                        break;
                    case 3:
                        this.state.italic = true;
                        break;
                    case 4:
                        this.state.underline = true;
                        break;
                    case 5:
                        this.state.blink = true;
                        this.state.rapidBlink = false;
                        break;
                    case 6:
                        this.state.rapidBlink = true;
                        this.state.blink = false;
                        break;
                    case 7:
                        this.state.reverse = true;
                        break;
                    case 8:
                        this.state.secret = true;
                        break;
                    case 9:
                        this.state.strikethrough = true;
                        break;
                    case 22:
                        this.state.bold = false;
                        this.state.dim = false;
                        break;
                    case 23:
                        this.state.italic = false;
                        break;
                    case 24:
                        this.state.underline = false;
                        break;
                    case 25:
                        this.state.blink = false;
                        this.state.rapidBlink = false;
                        break;
                    case 27:
                        this.state.reverse = false;
                        break;
                    case 28:
                        this.state.secret = false;
                        break;
                    case 29:
                        this.state.strikethrough = false;
                        break;
                    case 30:
                        this.state.foregroundColor = "black";
                        this.state.fgRgb = null;
                        break;
                    case 31:
                        this.state.foregroundColor = "red";
                        this.state.fgRgb = null;
                        break;
                    case 32:
                        this.state.foregroundColor = "green";
                        this.state.fgRgb = null;
                        break;
                    case 33:
                        this.state.foregroundColor = "yellow";
                        this.state.fgRgb = null;
                        break;
                    case 34:
                        this.state.foregroundColor = "blue";
                        this.state.fgRgb = null;
                        break;
                    case 35:
                        this.state.foregroundColor = "magenta";
                        this.state.fgRgb = null;
                        break;
                    case 36:
                        this.state.foregroundColor = "cyan";
                        this.state.fgRgb = null;
                        break;
                    case 37:
                        this.state.foregroundColor = "white";
                        this.state.fgRgb = null;
                        break;
                    case 38:
                        // Extended foreground: 38;5;n (256-color) or 38;2;r;g;b (true-color)
                        if (ci + 1 < codes.length) {
                            if (codes[ci + 1] === 5) {
                                if (ci + 2 < codes.length) {
                                    const idx = codes[ci + 2];
                                    if (idx >= 0 && idx <= 7 && ANSI_NAMED[idx]) {
                                        this.state.foregroundColor = ANSI_NAMED[idx];
                                        this.state.fgRgb = null;
                                    }
                                    else if (idx >= 0 && idx <= 255 && ANSI_256[idx]) {
                                        this.state.foregroundColor = null;
                                        this.state.fgRgb = ANSI_256[idx];
                                    }
                                    ci += 2;
                                }
                                else {
                                    ci += 1;
                                }
                            }
                            else if (codes[ci + 1] === 2) {
                                if (ci + 4 < codes.length) {
                                    this.state.foregroundColor = null;
                                    const r = Math.max(0, Math.min(255, codes[ci + 2]));
                                    const g = Math.max(0, Math.min(255, codes[ci + 3]));
                                    const b = Math.max(0, Math.min(255, codes[ci + 4]));
                                    this.state.fgRgb = "rgb(" + r + "," + g + "," + b + ")";
                                    ci += 4;
                                }
                                else {
                                    ci = codes.length - 1;
                                }
                            }
                        }
                        break;
                    case 39:
                        this.state.foregroundColor = null;
                        this.state.fgRgb = null;
                        break;
                    case 40:
                        this.state.backgroundColor = "black";
                        this.state.bgRgb = null;
                        break;
                    case 41:
                        this.state.backgroundColor = "red";
                        this.state.bgRgb = null;
                        break;
                    case 42:
                        this.state.backgroundColor = "green";
                        this.state.bgRgb = null;
                        break;
                    case 43:
                        this.state.backgroundColor = "yellow";
                        this.state.bgRgb = null;
                        break;
                    case 44:
                        this.state.backgroundColor = "blue";
                        this.state.bgRgb = null;
                        break;
                    case 45:
                        this.state.backgroundColor = "magenta";
                        this.state.bgRgb = null;
                        break;
                    case 46:
                        this.state.backgroundColor = "cyan";
                        this.state.bgRgb = null;
                        break;
                    case 47:
                        this.state.backgroundColor = "white";
                        this.state.bgRgb = null;
                        break;
                    case 48:
                        // Extended background: 48;5;n (256-color) or 48;2;r;g;b (true-color)
                        if (ci + 1 < codes.length) {
                            if (codes[ci + 1] === 5) {
                                if (ci + 2 < codes.length) {
                                    const idx = codes[ci + 2];
                                    if (idx >= 0 && idx <= 7 && ANSI_NAMED[idx]) {
                                        this.state.backgroundColor = ANSI_NAMED[idx];
                                        this.state.bgRgb = null;
                                    }
                                    else if (idx >= 0 && idx <= 255 && ANSI_256[idx]) {
                                        this.state.backgroundColor = null;
                                        this.state.bgRgb = ANSI_256[idx];
                                    }
                                    ci += 2;
                                }
                                else {
                                    ci += 1;
                                }
                            }
                            else if (codes[ci + 1] === 2) {
                                if (ci + 4 < codes.length) {
                                    this.state.backgroundColor = null;
                                    const r = Math.max(0, Math.min(255, codes[ci + 2]));
                                    const g = Math.max(0, Math.min(255, codes[ci + 3]));
                                    const b = Math.max(0, Math.min(255, codes[ci + 4]));
                                    this.state.bgRgb = "rgb(" + r + "," + g + "," + b + ")";
                                    ci += 4;
                                }
                                else {
                                    ci = codes.length - 1;
                                }
                            }
                        }
                        break;
                    case 49:
                        this.state.backgroundColor = null;
                        this.state.bgRgb = null;
                        break;
                    // Bright foreground colors
                    case 90:
                        this.state.foregroundColor = null;
                        this.state.fgRgb = ANSI_256[8];
                        break;
                    case 91:
                        this.state.foregroundColor = null;
                        this.state.fgRgb = ANSI_256[9];
                        break;
                    case 92:
                        this.state.foregroundColor = null;
                        this.state.fgRgb = ANSI_256[10];
                        break;
                    case 93:
                        this.state.foregroundColor = null;
                        this.state.fgRgb = ANSI_256[11];
                        break;
                    case 94:
                        this.state.foregroundColor = null;
                        this.state.fgRgb = ANSI_256[12];
                        break;
                    case 95:
                        this.state.foregroundColor = null;
                        this.state.fgRgb = ANSI_256[13];
                        break;
                    case 96:
                        this.state.foregroundColor = null;
                        this.state.fgRgb = ANSI_256[14];
                        break;
                    case 97:
                        this.state.foregroundColor = null;
                        this.state.fgRgb = ANSI_256[15];
                        break;
                    // Bright background colors
                    case 100:
                        this.state.backgroundColor = null;
                        this.state.bgRgb = ANSI_256[8];
                        break;
                    case 101:
                        this.state.backgroundColor = null;
                        this.state.bgRgb = ANSI_256[9];
                        break;
                    case 102:
                        this.state.backgroundColor = null;
                        this.state.bgRgb = ANSI_256[10];
                        break;
                    case 103:
                        this.state.backgroundColor = null;
                        this.state.bgRgb = ANSI_256[11];
                        break;
                    case 104:
                        this.state.backgroundColor = null;
                        this.state.bgRgb = ANSI_256[12];
                        break;
                    case 105:
                        this.state.backgroundColor = null;
                        this.state.bgRgb = ANSI_256[13];
                        break;
                    case 106:
                        this.state.backgroundColor = null;
                        this.state.bgRgb = ANSI_256[14];
                        break;
                    case 107:
                        this.state.backgroundColor = null;
                        this.state.bgRgb = ANSI_256[15];
                        break;
                }
            }
        }
        addSpan(line.substring(i));
        return lineSpan;
    }
    processLines() {
        const atBottom = this.targetElement.scrollTop >
            this.targetElement.scrollHeight - this.targetElement.offsetHeight - 50;
        const prevCarriageReturn = this.state.carriageReturn;
        const fragment = document.createDocumentFragment();
        if (this.state.lines.length === 0) {
            return;
        }
        for (const line of this.state.lines) {
            if (line === "\r") {
                this.state.carriageReturn = true;
                continue;
            }
            if (this.state.carriageReturn && line !== "\n") {
                if (fragment.childElementCount) {
                    fragment.removeChild(fragment.lastChild);
                }
            }
            const hadCarriageReturn = line.endsWith("\r");
            fragment.appendChild(this.processLine(line.replace(/\r/g, "")));
            this.state.carriageReturn = hadCarriageReturn;
        }
        if (prevCarriageReturn &&
            fragment.childElementCount > 0 &&
            this.targetElement.lastChild) {
            this.targetElement.replaceChild(fragment, this.targetElement.lastChild);
        }
        else {
            this.targetElement.appendChild(fragment);
        }
        this.state.lines = [];
        if (atBottom) {
            this.targetElement.scrollTop = this.targetElement.scrollHeight;
        }
    }
    addLine(line) {
        if (this.state.lines.length === 0) {
            setTimeout(() => this.processLines(), 0);
        }
        this.state.lines.push(line);
    }
}
export const coloredConsoleStyles = `
  .log {
    flex: 1;
    background-color: #1c1c1c;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier,
      monospace;
    font-size: 12px;
    padding: 16px;
    overflow: auto;
    line-height: 1.45;
    border-radius: 3px;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    color: #ddd;
  }

  .log-bold {
    font-weight: bold;
  }
  .log-dim {
    opacity: 0.5;
  }
  .log-italic {
    font-style: italic;
  }
  .log-underline {
    text-decoration: underline;
  }
  .log-strikethrough {
    text-decoration: line-through;
  }
  .log-underline.log-strikethrough {
    text-decoration: underline line-through;
  }
  .log-blink {
    animation: blink 1s step-end infinite;
  }
  .log-rapid-blink {
    animation: blink 0.4s step-end infinite;
  }
  @keyframes blink {
    50% {
      opacity: 0;
    }
  }
  .log-secret {
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
    user-select: none;
  }
  .log-secret-redacted {
    opacity: 0;
    width: 1px;
    font-size: 1px;
  }
  .log-reverse {
    background: #ddd;
    color: #1c1c1c;
  }
  .log-fg-black {
    color: rgb(128, 128, 128);
  }
  .log-fg-red {
    color: rgb(255, 0, 0);
  }
  .log-fg-green {
    color: rgb(0, 255, 0);
  }
  .log-fg-yellow {
    color: rgb(255, 255, 0);
  }
  .log-fg-blue {
    color: rgb(0, 0, 255);
  }
  .log-fg-magenta {
    color: rgb(255, 0, 255);
  }
  .log-fg-cyan {
    color: rgb(0, 255, 255);
  }
  .log-fg-white {
    color: rgb(187, 187, 187);
  }
  .log-bg-black {
    background-color: rgb(0, 0, 0);
  }
  .log-bg-red {
    background-color: rgb(255, 0, 0);
  }
  .log-bg-green {
    background-color: rgb(0, 255, 0);
  }
  .log-bg-yellow {
    background-color: rgb(255, 255, 0);
  }
  .log-bg-blue {
    background-color: rgb(0, 0, 255);
  }
  .log-bg-magenta {
    background-color: rgb(255, 0, 255);
  }
  .log-bg-cyan {
    background-color: rgb(0, 255, 255);
  }
  .log-bg-white {
    background-color: rgb(255, 255, 255);
  }
`;
