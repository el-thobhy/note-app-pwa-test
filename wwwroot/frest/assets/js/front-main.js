"use strict";
let isRtl = window.Helpers.isRtl()
    , isDarkStyle = window.Helpers.isDarkStyle();
!function () {
    const t = document.getElementById("navbarSupportedContent")
        , o = document.querySelector(".layout-navbar")
        , e = document.querySelectorAll(".navbar-nav .nav-link");
    function l() {
        t.classList.remove("show")
    }
    setTimeout(function () {
        window.Helpers.initCustomOptionCheck()
    }, 1e3),
        [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]')).map(function (e) {
            return new bootstrap.Tooltip(e)
        }),
        isRtl && Helpers._addClass("dropdown-menu-end", document.querySelectorAll("#layout-navbar .dropdown-menu")),
        window.addEventListener("scroll", e => {
            10 < window.scrollY ? o.classList.add("navbar-active") : o.classList.remove("navbar-active")
        }
        ),
        window.addEventListener("load", e => {
            10 < window.scrollY ? o.classList.add("navbar-active") : o.classList.remove("navbar-active")
        }
        ),
        document.addEventListener("click", function (e) {
            t.contains(e.target) || l()
        }),
        e.forEach(t => {
            t.addEventListener("click", e => {
                t.classList.contains("dropdown-toggle") ? e.preventDefault() : l()
            }
            )
        }
        ),
        isRtl && Helpers._addClass("dropdown-menu-end", document.querySelectorAll(".dropdown-menu"));
    var a, s = document.querySelectorAll(".nav-link.mega-dropdown"), s = (s && s.forEach(e => {
        new MegaDropdown(e)
    }
    ),
        document.querySelector(".dropdown-style-switcher")), n = localStorage.getItem("templateCustomizer-" + templateName + "--Style") || (window.templateCustomizer?.settings?.defaultStyle ?? "light");
    window.templateCustomizer && s && ([].slice.call(s.children[1].querySelectorAll(".dropdown-item")).forEach(function (e) {
        e.addEventListener("click", function () {
            var e = this.getAttribute("data-theme");
            "light" === e ? window.templateCustomizer.setStyle("light") : "dark" === e ? window.templateCustomizer.setStyle("dark") : window.templateCustomizer.setStyle("system")
        })
    }),
        s = s.querySelector("i"),
        "light" === n ? (s.classList.add("bx-sun"),
            new bootstrap.Tooltip(s, {
                title: "Light Mode",
                fallbackPlacements: ["bottom"]
            })) : "dark" === n ? (s.classList.add("bx-moon"),
                new bootstrap.Tooltip(s, {
                    title: "Dark Mode",
                    fallbackPlacements: ["bottom"]
                })) : (s.classList.add("bx-desktop"),
                    new bootstrap.Tooltip(s, {
                        title: "System Mode",
                        fallbackPlacements: ["bottom"]
                    }))),
        "system" === (a = n) && (a = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
        [].slice.call(document.querySelectorAll("[data-app-" + a + "-img]")).map(function (e) {
            var t = e.getAttribute("data-app-" + a + "-img");
            e.src = assetsPath + "img/" + t
        });
    function i(e) {
        "show.bs.collapse" == e.type || "show.bs.collapse" == e.type ? e.target.closest(".accordion-item").classList.add("active") : e.target.closest(".accordion-item").classList.remove("active")
    }
    [].slice.call(document.querySelectorAll(".accordion")).map(function (e) {
        e.addEventListener("show.bs.collapse", i),
            e.addEventListener("hide.bs.collapse", i)
    })
}();
