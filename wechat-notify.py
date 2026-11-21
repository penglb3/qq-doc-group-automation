# %%
import os
import requests
from datetime import datetime

# %%
wxsend_key = os.environ['SCT_SENDKEY']
expire_date = os.environ['QQ_DOC_ACCESS_TOKEN_EXPIRE_DATE'] # YYYY-MM-DD

def wx_send(wxsend_key, data):
    try:
        r = requests.post(f'https://sctapi.ftqq.com/{wxsend_key}.send', data = data)
        if r.status_code == 200:
            print('发送通知成功')
        else:
            print(f'发送通知失败：HTTP错误代码{r.status_code}')
    except Exception as e:
        print(f'发送通知失败：代码运行时错误\n{e.__traceback__}')

def check_for_expire(wxsend_key, expire_date):
    # calculate the number of days left until the access token expires, and if it's less than 3 days, send a notification.
    
    expire_date = datetime.strptime(expire_date, "%Y-%m-%d")
    days_left = (expire_date - datetime.now()).days

    if days_left > 3:
        print(f'Access token is still valid for {days_left} days, skip notification.')
        return

    data = {
        "title": f'腾讯文档 Access Token 还有 {days_left} 天过期，记得更新！',
        "desp": "如遇身体不适、或居住地址发生变化，请及时更新健康申报信息。"
    }
    wx_send(wxsend_key, data)

if __name__ == "__main__":
    check_for_expire(wxsend_key, expire_date)