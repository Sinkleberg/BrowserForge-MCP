import type { Exporter, Flow, FlowStep, Locator } from '../schema.js';
import { defaultsOf, frameMatch, header, q, stepLabel } from './common.js';

const xq = (s: string): string => (s.includes("'") ? `concat('${s.split("'").join(`', "'", '`)}')` : `'${s}'`);

/** [strategy, value] pairs for Selenium, best first. Selenium has no role/label locators, so those become XPath/CSS. */
export function seleniumCandidates(loc: Locator | undefined): [string, string][] {
  if (!loc) return [];
  const out: [string, string][] = [];
  if (loc.testId) out.push(['CSS', `[data-testid=${JSON.stringify(loc.testId)}]`]);
  if (loc.id) out.push(['ID', loc.id]);
  if (loc.nameAttr) out.push(['NAME', loc.nameAttr]);
  if (loc.label) out.push(['XPATH', `//*[@aria-label=${xq(loc.label)}] | //label[normalize-space(.)=${xq(loc.label)}]/following::*[self::input or self::textarea or self::select][1]`]);
  if (loc.placeholder) out.push(['CSS', `[placeholder=${JSON.stringify(loc.placeholder)}]`]);
  if (loc.role && loc.name) out.push(['XPATH', `//*[(@role=${xq(loc.role)} or self::${loc.role === 'link' ? 'a' : loc.role === 'textbox' ? 'input' : loc.role}) and normalize-space(.)=${xq(loc.name)}]`]);
  if (loc.text) out.push(['XPATH', `//*[normalize-space(text())=${xq(loc.text)}]`]);
  if (loc.css) out.push(['CSS', loc.css]);
  if (loc.xpath) out.push(['XPATH', loc.xpath]);
  return out;
}

// ---------- Python ----------
const PY_BY: Record<string, string> = { CSS: 'By.CSS_SELECTOR', ID: 'By.ID', NAME: 'By.NAME', XPATH: 'By.XPATH' };

function pyStep(s: FlowStep, i: number): string[] {
  const lines = [`    # ${stepLabel(s, i)}`];
  const guard = s.consequential ? [`    if not CONFIRMED:\n        stop(3, ${q(`Step ${i + 1} is consequential (${s.label ?? s.action}). Review the flow, then re-run with FLOW_CONFIRM=1 to perform it.`)})`] : [];
  const cands = `[${seleniumCandidates(s.locator).map(([by, v]) => `(${PY_BY[by]}, ${q(v)})`).join(', ')}]`;
  const what = q(s.label ?? s.action);
  const frame = s.frame ? [`    enter_frame(${q(`iframe[src*=${JSON.stringify(frameMatch(s.frame.url))}]`)})`] : [`    driver.switch_to.default_content()`];
  const find = `find(${cands}, ${what})`;
  switch (s.action) {
    case 'navigate': return [...lines, `    driver.get(${q(s.url ?? '')})`];
    case 'click': return [...lines, ...guard, ...frame, `    ${find}.click()`];
    case 'fill': return [...lines, ...guard, ...frame, `    el = ${find}`, `    el.clear()`, `    el.send_keys(p(${q(s.param ?? '')}))`];
    case 'upload': return [...lines, ...guard, ...frame, `    ${find}.send_keys(p(${q(s.param ?? '')}))`];
    case 'press': return [...lines, ...guard, ...frame, `    ${s.locator ? find : 'driver.switch_to.active_element'}.send_keys(KEYS.get(${q(s.key ?? 'Enter')}, ${q(s.key ?? 'Enter')}))`];
    case 'select':
      if (s.custom) return [...lines, ...frame, `    ${find}.click()`, `    find([(By.XPATH, '//*[@role="option"][normalize-space(.)=' + xpath_literal(p(${q(s.param ?? '')})) + ']')], "option").click()`];
      return [...lines, ...guard, ...frame, `    Select(${find}).select_by_visible_text(p(${q(s.param ?? '')}))`];
  }
}

export const seleniumPy: Exporter = {
  format: 'selenium-py',
  description: 'Selenium script in Python (run with: python flow.py)',
  extension: 'py',
  generate(flow: Flow, opts) {
    return `${header(flow, '#')}
import json
import os
import sys
import time

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import Select

DEFAULTS = ${JSON.stringify(defaultsOf(flow, opts), null, 4)}
# Values come from flow-params.json or FLOW_PARAM_<NAME> environment variables (they override the defaults above).
FILE = json.load(open("flow-params.json")) if os.path.exists("flow-params.json") else {}
CONFIRMED = os.environ.get("FLOW_CONFIRM") == "1"
KEYS = {"Enter": Keys.ENTER, "Tab": Keys.TAB, "Escape": Keys.ESCAPE, "ArrowDown": Keys.ARROW_DOWN, "ArrowUp": Keys.ARROW_UP}


def p(name):
    value = os.environ.get("FLOW_PARAM_" + name.upper(), FILE.get(name, DEFAULTS.get(name)))
    if value is None:
        raise RuntimeError(f'Missing parameter "{name}": set FLOW_PARAM_{name.upper()} or add it to flow-params.json')
    return value


def xpath_literal(s):
    if "'" not in s:
        return "'" + s + "'"
    return "concat('" + s.replace("'", "', \\"'\\", '") + "')"


options = webdriver.ChromeOptions()
if os.environ.get("HEADLESS") != "0":
    options.add_argument("--headless=new")
driver = webdriver.Chrome(options=options)


def find(candidates, what, timeout=15):
    """Try each locator in order: the one matching exactly one element wins, then the first with any match."""
    end = time.time() + timeout
    while time.time() < end:
        for by, value in candidates:
            els = driver.find_elements(by, value)
            if len(els) == 1:
                return els[0]
        for by, value in candidates:
            els = driver.find_elements(by, value)
            if els:
                return els[0]
        time.sleep(0.25)
    raise RuntimeError("No element found for " + what)


def enter_frame(css):
    driver.switch_to.default_content()
    driver.switch_to.frame(find([(By.CSS_SELECTOR, css)], "iframe " + css))


def stop(code, message=None):
    if message:
        print(message, file=sys.stderr)
    driver.quit()
    sys.exit(code)


try:
    pass
${flow.steps.flatMap((s, i) => pyStep(s, i)).join('\n')}
    print("Flow finished.")
    driver.quit()
except SystemExit:
    raise
except Exception as e:
    stop(1, str(e))
`;
  },
};

// ---------- Java ----------
const JAVA_BY: Record<string, string> = { CSS: 'By.cssSelector', ID: 'By.id', NAME: 'By.name', XPATH: 'By.xpath' };

function javaStep(s: FlowStep, i: number): string[] {
  const lines = [`            // ${stepLabel(s, i)}`];
  const guard = s.consequential ? [`            if (!CONFIRMED) stop(3, ${q(`Step ${i + 1} is consequential (${s.label ?? s.action}). Review the flow, then re-run with FLOW_CONFIRM=1 to perform it.`)});`] : [];
  const by = seleniumCandidates(s.locator).map(([k, v]) => `${JAVA_BY[k]}(${q(v)})`).join(', ');
  const what = q(s.label ?? s.action);
  const frame = s.frame ? [`            enterFrame(${q(`iframe[src*=${JSON.stringify(frameMatch(s.frame.url))}]`)});`] : [`            driver.switchTo().defaultContent();`];
  const find = `find(${what}${by ? ', ' + by : ''})`;
  switch (s.action) {
    case 'navigate': return [...lines, `            driver.get(${q(s.url ?? '')});`];
    case 'click': return [...lines, ...guard, ...frame, `            ${find}.click();`];
    case 'fill': return [...lines, ...guard, ...frame, `            WebElement el${i} = ${find};`, `            el${i}.clear();`, `            el${i}.sendKeys(p(${q(s.param ?? '')}));`];
    case 'upload': return [...lines, ...guard, ...frame, `            ${find}.sendKeys(p(${q(s.param ?? '')}));`];
    case 'press': return [...lines, ...guard, ...frame, `            ${s.locator ? find : 'driver.switchTo().activeElement()'}.sendKeys(key(${q(s.key ?? 'Enter')}));`];
    case 'select':
      if (s.custom) return [...lines, ...frame, `            ${find}.click();`, `            find("option", By.xpath("//*[@role='option'][normalize-space(.)=" + xq(p(${q(s.param ?? '')})) + "]")).click();`];
      return [...lines, ...guard, ...frame, `            new Select(${find}).selectByVisibleText(p(${q(s.param ?? '')}));`];
  }
}

export const seleniumJava: Exporter = {
  format: 'selenium-java',
  description: 'Selenium class in Java (compile with the selenium-java jars; run: java Flow)',
  extension: 'java',
  generate(flow: Flow, opts) {
    const d = defaultsOf(flow, opts);
    return `${header(flow, '//')}
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.openqa.selenium.By;
import org.openqa.selenium.Keys;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.chrome.ChromeOptions;
import org.openqa.selenium.support.ui.Select;

public class Flow {
    static final Map<String, String> DEFAULTS = new HashMap<>();
    static {
${Object.entries(d).map(([k, v]) => `        DEFAULTS.put(${q(k)}, ${q(v)});`).join('\n')}
    }
    // Values come from FLOW_PARAM_<NAME> environment variables (they override the defaults above).
    static final boolean CONFIRMED = "1".equals(System.getenv("FLOW_CONFIRM"));
    static WebDriver driver;

    static String p(String name) {
        String v = System.getenv("FLOW_PARAM_" + name.toUpperCase());
        if (v == null) v = DEFAULTS.get(name);
        if (v == null) throw new RuntimeException("Missing parameter \\"" + name + "\\": set FLOW_PARAM_" + name.toUpperCase());
        return v;
    }

    static String xq(String s) {
        return s.contains("'") ? "concat('" + s.replace("'", "', \\"'\\", '") + "')" : "'" + s + "'";
    }

    static CharSequence key(String name) {
        switch (name) {
            case "Enter": return Keys.ENTER;
            case "Tab": return Keys.TAB;
            case "Escape": return Keys.ESCAPE;
            case "ArrowDown": return Keys.ARROW_DOWN;
            case "ArrowUp": return Keys.ARROW_UP;
            default: return name;
        }
    }

    /** Try each locator in order: the one matching exactly one element wins, then the first with any match. */
    static WebElement find(String what, By... candidates) throws InterruptedException {
        long end = System.currentTimeMillis() + 15000;
        while (System.currentTimeMillis() < end) {
            for (By by : candidates) {
                List<WebElement> els = driver.findElements(by);
                if (els.size() == 1) return els.get(0);
            }
            for (By by : candidates) {
                List<WebElement> els = driver.findElements(by);
                if (!els.isEmpty()) return els.get(0);
            }
            Thread.sleep(250);
        }
        throw new RuntimeException("No element found for " + what);
    }

    static void enterFrame(String css) throws InterruptedException {
        driver.switchTo().defaultContent();
        driver.switchTo().frame(find("iframe " + css, By.cssSelector(css)));
    }

    static void stop(int code, String message) {
        if (message != null) System.err.println(message);
        driver.quit();
        System.exit(code);
    }

    public static void main(String[] args) {
        ChromeOptions options = new ChromeOptions();
        if (!"0".equals(System.getenv("HEADLESS"))) options.addArguments("--headless=new");
        driver = new ChromeDriver(options);
        try {
${flow.steps.flatMap((s, i) => javaStep(s, i)).join('\n')}
            System.out.println("Flow finished.");
            driver.quit();
        } catch (Exception e) {
            stop(1, String.valueOf(e.getMessage()));
        }
    }
}
`;
  },
};

