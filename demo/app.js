/**
 * FlowBoard demo landing page — Flagsmith wiring.
 *
 * - Identity: a UUID kept in localStorage (`flowboard_identity`); override
 *   with ?identity=<id> to walk through the other variant manually.
 * - The experiment flag is read with flagsmith.getExperimentFlag('landing_cta')
 *   (requires enableEvents: true). Evaluating it records the exposure.
 * - Variant copy comes from the flag: control = flag's own value,
 *   treatment = multivariate variant key "treatment".
 * - CTA click  -> trackEvent('cta_clicked')   (secondary metric, observed only)
 * - Form submit -> trackEvent('signup_completed') (primary metric)
 * - ?preview=control|treatment renders a variant locally WITHOUT touching
 *   the SDK (labelled as local preview, sends no events).
 *
 * Without a Flagsmith environment key (demo/config.js missing) the page
 * renders the hard-coded control copy and sends nothing.
 */
(function () {
  "use strict";

  var FLAG_NAME = "landing_cta";
  var PRIMARY_EVENT = "signup_completed";
  var SECONDARY_EVENT = "cta_clicked";

  var COPY = {
    control: {
      headline: "Organize your team's work in one place",
      cta: "Start free trial",
    },
    treatment: {
      headline: "Ship projects twice as fast — start today",
      cta: "Get started free",
    },
  };

  var $ = function (id) {
    return document.getElementById(id);
  };

  function params() {
    return new URLSearchParams(window.location.search);
  }

  function getIdentity() {
    var override = params().get("identity");
    if (override) return override;
    var stored = null;
    try {
      stored = window.localStorage.getItem("flowboard_identity");
    } catch (e) {
      /* storage unavailable (private mode) — fall through to a fresh id */
    }
    if (stored) return stored;
    var id =
      window.crypto && window.crypto.randomUUID
        ? window.crypto.randomUUID()
        : "anon-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try {
      window.localStorage.setItem("flowboard_identity", id);
    } catch (e) {
      /* ignore */
    }
    return id;
  }

  function showBanner(text) {
    var b = $("banner");
    b.textContent = text;
    b.classList.add("show");
  }

  function renderVariant(variant, mode) {
    var copy = COPY[variant] || COPY.control;
    $("headline").textContent = copy.headline;
    $("cta").textContent = copy.cta;
    $("variant-tag").textContent =
      mode === "preview"
        ? "本地预览：" + variant + "（未走 Flagsmith，不计入实验）"
        : "当前变体：" + variant + "（由 Flagsmith flag " + FLAG_NAME + " 决定）";
  }

  function wireEvents() {
    $("cta").addEventListener("click", function () {
      if (window.flagsmith) window.flagsmith.trackEvent(SECONDARY_EVENT);
      $("signup-form").classList.add("show");
      $("cta").style.display = "none";
    });
    $("signup-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (window.flagsmith) window.flagsmith.trackEvent(PRIMARY_EVENT);
      $("signup-form").classList.remove("show");
      $("success").classList.add("show");
    });
  }

  function init() {
    wireEvents();

    // Local preview override: no SDK evaluation, no events.
    var preview = params().get("preview");
    if (preview === "control" || preview === "treatment") {
      renderVariant(preview, "preview");
      showBanner("本地预览模式（?preview=" + preview + "）：未连接 Flagsmith，不产生 exposure 与事件。");
      return;
    }

    var config = window.FLOWBOARD_CONFIG;
    if (!config || !config.environmentID) {
      renderVariant("control", "preview");
      showBanner(
        "未配置 Flagsmith 环境 key：当前为本地预览（control 版），事件不发送。运行 npm run demo:config 生成 demo/config.js 后刷新。",
      );
      return;
    }
    if (!window.flagsmith) {
      renderVariant("control", "preview");
      showBanner("Flagsmith SDK 未加载（检查网络/CDN），当前为本地预览（control 版）。");
      return;
    }

    var identity = getIdentity();
    window.flagsmith
      .init({
        environmentID: config.environmentID,
        identity: identity,
        enableEvents: true,
        onChange: function () {
          var flag = window.flagsmith.getExperimentFlag(FLAG_NAME);
          if (!flag) {
            renderVariant("control", "live");
            return;
          }
          // Multivariate: variant key "treatment" marks the treatment arm;
          // otherwise the flag's own value ("control") is served.
          var variant = flag.variant === "treatment" || flag.value === "treatment" ? "treatment" : "control";
          renderVariant(variant, "live");
          if (window.console && console.log) {
            console.log("[flagsmith] identity=" + identity + " variant=" + variant, flag);
          }
        },
        onError: function (err) {
          showBanner("Flagsmith 加载失败：" + (err && err.message ? err.message : err) + "。当前为 control 版。");
          renderVariant("control", "preview");
        },
      })
      .catch(function (err) {
        showBanner("Flagsmith 初始化失败：" + (err && err.message ? err.message : err) + "。当前为 control 版。");
        renderVariant("control", "preview");
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
