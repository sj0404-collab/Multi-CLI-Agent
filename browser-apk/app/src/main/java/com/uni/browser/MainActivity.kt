package com.uni.browser

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.os.Bundle
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.JavascriptInterface

@SuppressLint("SetJavaScriptEnabled")
class MainActivity : Activity() {

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            webView = WebView(this)
            setContentView(webView)

            val settings = webView.settings
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            settings.allowContentAccess = true
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            settings.cacheMode = WebSettings.LOAD_NO_CACHE

            webView.addJavascriptInterface(Bridge(this), "AndroidBridge")
            webView.loadUrl("file:///android_asset/index.html")
        } catch (t: Throwable) {
            // Показываем ошибку текстом вместо краша
            android.widget.TextView(this).apply {
                text = "Ошибка: " + (t.message ?: t.toString())
            }.also { setContentView(it) }
        }
    }

    class Bridge(private val ctx: Context) {
        @JavascriptInterface
        fun backendBase(): String = "http://127.0.0.1:8765"
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack()
        else super.onBackPressed()
    }
}
