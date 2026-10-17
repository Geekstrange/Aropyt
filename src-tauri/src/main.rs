// Windows 发布版不弹控制台窗口。开发版保留，便于看 panic 输出。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    aropyt_lib::run();
}