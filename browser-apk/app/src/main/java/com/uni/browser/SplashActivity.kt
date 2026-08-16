package com.uni.browser

import android.animation.ObjectAnimator
import android.animation.AnimatorSet
import android.graphics.drawable.AnimationDrawable
import android.os.Bundle
import android.view.View
import android.view.animation.DecelerateInterpolator
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class SplashActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Анимированный фон (градиент-пульс)
        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.gravity = android.view.Gravity.CENTER
        root.setBackgroundColor(resources.getColor(R.color.splash_bg, theme))

        val icon = ImageView(this)
        icon.setImageResource(R.drawable.ic_launcher)
        val size = (resources.displayMetrics.density * 160).toInt()
        icon.layoutParams = LinearLayout.LayoutParams(size, size)

        val title = TextView(this)
        title.text = "Uni-Browser"
        title.setTextColor(resources.getColor(android.R.color.white, theme))
        title.textSize = 26f
        title.gravity = android.view.Gravity.CENTER
        title.layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)

        val subtitle = TextView(this)
        subtitle.text = "AI · Читалка · OCR · Голос"
        subtitle.setTextColor(0x88ffffff.toInt())
        subtitle.textSize = 14f
        subtitle.gravity = android.view.Gravity.CENTER

        root.addView(icon)
        root.addView(title)
        root.addView(subtitle)

        setContentView(root)

        // Анимация: появление + лёгкое покачивание логотипа
        icon.alpha = 0f
        icon.scaleX = 0.6f
        icon.scaleY = 0.6f
        val fade = ObjectAnimator.ofFloat(icon, "alpha", 0f, 1f).setDuration(600)
        val scaleX = ObjectAnimator.ofFloat(icon, "scaleX", 0.6f, 1f).setDuration(600)
        val scaleY = ObjectAnimator.ofFloat(icon, "scaleY", 0.6f, 1f).setDuration(600)
        val rot = ObjectAnimator.ofFloat(icon, "rotation", -8f, 0f).setDuration(700)
        val set = AnimatorSet()
        set.playTogether(fade, scaleX, scaleY, rot)
        set.interpolator = DecelerateInterpolator()
        set.start()

        // Переход к основному приложению после анимации
        root.postDelayed({
            val i = android.content.Intent(this, MainActivity::class.java)
            startActivity(i)
            overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out)
            finish()
        }, 1400)
    }
}
