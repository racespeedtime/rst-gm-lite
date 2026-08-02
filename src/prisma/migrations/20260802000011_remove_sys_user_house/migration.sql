-- 精简：移除 sys_user_house（房屋持有关联表）
-- 背景：暂时不做房屋购买系统，该表为购买关系的中间表，0 行数据，无其他对象引用
DROP TABLE "sys_user_house";
