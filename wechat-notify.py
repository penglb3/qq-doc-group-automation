#!/usr/bin/env python3
"""腾讯文档 access_token 到期检测 + 微信提醒（Server酱）。

背景：腾讯文档 OAuth2 的 access_token 有效期很长（当前这支到 2026-12-21），
但到期后二期的智能表接口会返回 `37019 Token 校验失败`，需要人重新授权并更新
GitHub secret `QQ_DOC_ACCESS_TOKEN`。本脚本每天跑一次，临近到期就推微信提醒。

有效期来源（按优先级）：
  1. 直接解析 QQ_DOC_ACCESS_TOKEN 这个 JWT 的 exp 字段（推荐，不需要手工维护日期）
  2. 环境变量 QQ_DOC_ACCESS_TOKEN_EXPIRE_DATE（YYYY-MM-DD）兜底

用法：
  python wechat-notify.py                    # 剩余 <= 7 天时推送
  python wechat-notify.py --warn-days 3      # 自定义阈值
  python wechat-notify.py --dry-run          # 只打印，不真的推送

环境变量：
  SCT_SENDKEY                      Server酱 SendKey（推送失败会退出码 1）
  QQ_DOC_ACCESS_TOKEN              腾讯文档 access_token
  QQ_DOC_ACCESS_TOKEN_EXPIRE_DATE  兜底到期日
  QQ_DOC_TOKEN_WARN_DAYS           兜底阈值（默认 7）

退出码：0 = 无需提醒或推送成功；1 = 配置缺失 / 推送失败。
"""
import argparse
import base64
import datetime as dt
import json
import os
import sys
import urllib.parse
import urllib.request

# An access token is only valid for 30 days, so 3 days is enough, or the warning will be too frequent.
DEFAULT_WARN_DAYS = 3


def parse_args():
    parser = argparse.ArgumentParser(description="腾讯文档 access_token 到期提醒")
    parser.add_argument("--warn-days", type=int, default=None, help="剩余多少天开始提醒（默认 7）")
    parser.add_argument("--dry-run", action="store_true", help="只打印，不推送")
    return parser.parse_args()


def token_expiry_date(token):
    """从 JWT 里解出 exp（Unix 秒）→ 本地时区的日期；解不出来返回 None。"""
    if not token:
        return None
    parts = token.split(".")
    if len(parts) < 2:
        return None
    payload = parts[1]
    payload += "=" * (-len(payload) % 4)
    try:
        data = json.loads(base64.urlsafe_b64decode(payload).decode("utf-8"))
        exp = int(data.get("exp"))
    except Exception:
        return None
    if exp <= 0:
        return None
    return dt.datetime.fromtimestamp(exp).date()


def resolve_expiry_date(token):
    exp = token_expiry_date(token)
    if exp:
        return exp, "JWT exp"
    raw = os.environ.get("QQ_DOC_ACCESS_TOKEN_EXPIRE_DATE", "").strip()
    if raw:
        try:
            return dt.datetime.strptime(raw, "%Y-%m-%d").date(), "QQ_DOC_ACCESS_TOKEN_EXPIRE_DATE"
        except ValueError:
            print(f"[提醒] 环境变量 QQ_DOC_ACCESS_TOKEN_EXPIRE_DATE 格式不对（应为 YYYY-MM-DD）：{raw}")
    return None, None


def wx_send(sendkey, title, desp):
    """Server酱推送（不依赖 requests，只用标准库）。成功返回 True。"""
    url = f"https://sctapi.ftqq.com/{sendkey}.send"
    data = urllib.parse.urlencode({"title": title, "desp": desp}).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8", "replace")
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            print(f"[提醒] 推送返回非 JSON：{body[:200]}")
            return False
        code = payload.get("code", payload.get("errno"))
        if code == 0:
            print("[提醒] 微信通知发送成功")
            return True
        print(f"[提醒] 微信通知发送失败：code={code} message={payload.get('message')}")
        return False
    except Exception as err:  # noqa: BLE001 - 这里要把任何网络异常都变成可读输出
        print(f"[提醒] 微信通知发送失败：{err}")
        return False


def main():
    args = parse_args()
    warn_days = args.warn_days
    if warn_days is None:
        warn_days = int(os.environ.get("QQ_DOC_TOKEN_WARN_DAYS", DEFAULT_WARN_DAYS) or DEFAULT_WARN_DAYS)

    token = os.environ.get("QQ_DOC_ACCESS_TOKEN", "").strip()
    expire_date, source = resolve_expiry_date(token)
    if not expire_date:
        print("[提醒] 拿不到 access_token 到期日：请设置 QQ_DOC_ACCESS_TOKEN（会解析 JWT exp）或 QQ_DOC_ACCESS_TOKEN_EXPIRE_DATE")
        return 1

    today = dt.date.today()
    days_left = (expire_date - today).days
    print(f"[提醒] access_token 到期日 {expire_date}（来源：{source}），今天 {today}，剩余 {days_left} 天，阈值 {warn_days} 天")

    if days_left > warn_days:
        print("[提醒] 还早，跳过通知")
        return 0

    if days_left >= 0:
        title = f"腾讯文档 Access Token 还有 {days_left} 天到期（{expire_date}）"
    else:
        title = f"腾讯文档 Access Token 已过期 {-days_left} 天（{expire_date}）"

    desp = "\n\n".join(
        [
            f"到期日：**{expire_date}**（剩余 {days_left} 天）",
            "影响：二期「许愿池自动结算」会因 `37019 Token 校验失败` 而失败（一期提醒不受影响）。",
            "处理：请前往 https://docs.qq.com/open#/ 重置 Access Token。",
        ]
    )

    print(f"[提醒] {title}")
    print(desp)
    if args.dry_run:
        print("[提醒] --dry-run：不实际推送")
        return 0

    sendkey = os.environ.get("SCT_SENDKEY", "").strip()
    if not sendkey:
        print("[提醒] 缺少 SCT_SENDKEY，无法推送微信")
        return 1
    return 0 if wx_send(sendkey, title, desp) else 1


if __name__ == "__main__":
    sys.exit(main())
